"""Write points in the multiscale Zarr layout of merfisheyes' points-zarr spec 0.1.

https://github.com/kresnajenie/merfisheyes/blob/main/docs/points-zarr-spec.md

A points element becomes a Zarr v3 group of levels. Level 0 holds every point and
each further level a uniform random quarter of the one below. Every level stores the
points twice: ``tile_major`` (sorted by tile, then feature) for "everything in this
region" and ``feature_major`` (sorted by feature, then tile) for "this feature
anywhere". An ``index`` of row numbers says where each tile's and each feature's
rows are, so a reader plans a read from counts before fetching any point.

Experimental: the spec is one group's draft, built on maturity-0 zarr conventions.
A store holding such an element declares ``spatialdata_attrs.version`` ``0.3-zarr``,
which spatialdata 0.8 cannot read, so write it into a store of its own (see
:func:`write_points_zarr_store`) rather than into an existing SpatialData store.

This writer sorts in memory: the sort keys, coordinates and permutations of every
level must fit at once. Out-of-core writing (partition by tile, then sort) is not
implemented.
"""

from __future__ import annotations

import json
import math
import shutil
from pathlib import Path
from typing import Any, Sequence

import numpy as np
import pandas as pd
import zarr
from zarr.codecs import BloscCodec

POINTS_ZARR_VERSION = "0.1"
#: Rows per chunk of a point column, and chunks per shard: the reference writer's.
DEFAULT_CHUNK_ROWS = 65_536
DEFAULT_SHARD_CHUNKS = 64
#: Levels are added until one holds no more than this many points (spec §3).
COARSEST_LEVEL_TARGET = 1_000_000

_MULTISCALES_CONVENTION = {
    "uuid": "d35379db-88df-4056-af3a-620245f8e347",
    "name": "multiscales",
    "schema_url": "https://raw.githubusercontent.com/zarr-conventions/multiscales/refs/tags/v0.1/schema.json",
    "spec_url": "https://github.com/zarr-conventions/multiscales/blob/v0.1/README.md",
}
_POINTS_CONVENTION = {
    "name": "points:",
    "description": "Multiscale points: levels, tile- and feature-major orders, row index",
    "spec_url": "https://github.com/kresnajenie/merfisheyes/blob/develop/docs/points-zarr-spec.md",
}
_DATAFRAME_CONVENTION = {"uuid": "1f1b36d2-3185-6da8-91f6-9a0823af2d33", "name": "df:"}
_ENUM_CONVENTION = {"uuid": "c906c423-56ed-413c-9943-7b2ff52d18f2", "name": "enum:"}


def _compressor(dtype: np.dtype) -> BloscCodec:
    return BloscCodec(cname="zstd", clevel=3, shuffle="shuffle", typesize=dtype.itemsize)


def _write_column(
    group: zarr.Group, name: str, data: np.ndarray, chunk_rows: int, shard_chunks: int
) -> None:
    chunk = max(1, min(chunk_rows, len(data)))
    group.create_array(
        name,
        data=data,
        chunks=(chunk,),
        shards=(chunk * shard_chunks,),
        compressors=_compressor(data.dtype),
    )


def _write_index(group: zarr.Group, name: str, data: np.ndarray, chunk_rows: int) -> None:
    group.create_array(
        name,
        data=data,
        chunks=(max(1, min(chunk_rows, len(data))),),
        compressors=_compressor(data.dtype),
    )


def _write_strings(group: zarr.Group, name: str, values: Sequence[str]) -> None:
    # Variable-length UTF-8 (`string`), as the spec's readers expect; numpy's `str`
    # would be written as fixed-length UTF-32.
    group.create_array(name, data=np.asarray(list(values), dtype=np.dtypes.StringDType()))


def _offsets(counts: np.ndarray) -> np.ndarray:
    """Run starts from run lengths, with the total appended: the index's row form."""
    return np.concatenate(([0], np.cumsum(counts))).astype(np.uint64)


def _write_dataframe(
    group: zarr.Group,
    columns: list[tuple[str, np.ndarray]],
    *,
    feature_key: str,
    features: Sequence[str],
    attrs: dict[str, Any],
    chunk_rows: int,
    shard_chunks: int,
) -> None:
    """One row order, in the `df:` convention; the feature column as an `enum:`."""
    n_rows = len(columns[0][1]) if columns else 0
    group.attrs.update(
        {
            "zarr_conventions": [_DATAFRAME_CONVENTION],
            "df:shape": [n_rows, len(columns)],
            **attrs,
        }
    )
    _write_strings(group, "columns", [name for name, _ in columns])
    for i, (name, data) in enumerate(columns):
        member = f"column_{i}"
        if name == feature_key:
            enum = group.create_group(member)
            enum.attrs.update(
                {
                    "zarr_conventions": [_ENUM_CONVENTION],
                    "enum:ordered": False,
                    "enum:codes": ["codes"],
                }
            )
            _write_column(enum, "codes", data, chunk_rows, shard_chunks)
            _write_strings(enum, "enum_values", features)
        else:
            _write_column(group, member, data, chunk_rows, shard_chunks)


def _default_level_count(n_points: int) -> int:
    if n_points <= COARSEST_LEVEL_TARGET:
        return 1
    return 1 + math.ceil(math.log(n_points / COARSEST_LEVEL_TARGET, 4))


def write_points_zarr(
    df: pd.DataFrame,
    element_dir: str | Path,
    *,
    feature_key: str,
    coordinates: Sequence[str] = ("x", "y"),
    tile_size: float = 100.0,
    n_levels: int | None = None,
    seed: int = 0,
    units: str = "micrometer",
    coordinate_system: str = "global",
    transformations: list[dict[str, Any]] | None = None,
    chunk_rows: int = DEFAULT_CHUNK_ROWS,
    shard_chunks: int = DEFAULT_SHARD_CHUNKS,
    overwrite: bool = False,
) -> dict[str, Any]:
    """Write ``df`` as a points-zarr element group at ``element_dir``.

    ``coordinates`` name the coordinate columns, two or three, written as axes ``x``,
    ``y`` and ``z`` in that order; ``feature_key`` names the
    categorical column. A pandas categorical keeps its categories (and their order)
    as the feature list; any other column is made categorical, with sorted names.
    Levels are added until one holds about a million points unless ``n_levels`` is
    given, stopping early at a level that would be empty. ``seed`` fixes the random
    sample, so a rerun on the same input writes the same rows.

    ``transformations`` are written as the element's ``coordinateTransformations``,
    so an element converted from another keeps its placement (copy them from the
    source element's attrs); by default, identity into ``coordinate_system``.

    Returns a summary: point counts per level and the feature list.
    """
    element_dir = Path(element_dir)
    if not 2 <= len(coordinates) <= 3:
        raise ValueError(f"coordinates must name two or three columns, got {list(coordinates)}")
    missing = [c for c in (*coordinates, feature_key) if c not in df.columns]
    if missing:
        raise ValueError(f"Missing columns: {', '.join(missing)}")
    if element_dir.exists():
        if not overwrite:
            raise FileExistsError(f"{element_dir} exists; pass overwrite=True to replace it")
        shutil.rmtree(element_dir)

    categorical = pd.Categorical(df[feature_key])
    if (categorical.codes < 0).any():
        raise ValueError(f"Column {feature_key!r} has missing values")
    features = [str(c) for c in categorical.categories]
    code_dtype = np.uint16 if len(features) <= np.iinfo(np.uint16).max + 1 else np.uint32
    codes0 = categorical.codes.astype(code_dtype)
    axes = ("x", "y", "z")[: len(coordinates)]
    coords0 = [df[c].to_numpy(dtype=np.float32) for c in coordinates]
    n_points = len(df)

    extent_min = [float(c.min()) for c in coords0]
    extent_max = [float(c.max()) for c in coords0]
    (x0, y0), (x1, y1) = extent_min[:2], extent_max[:2]

    # One uniform draw per point; level k is every point with r < 4^-k, so levels are
    # nested uniform samples of each other.
    r0 = np.random.default_rng(seed).random(n_points)
    level_count = n_levels if n_levels is not None else _default_level_count(n_points)

    root = zarr.open_group(element_dir, mode="w", zarr_format=3)
    layout: list[dict[str, Any]] = []
    # Level-0 tile_major row of every point, by original row: the point's id.
    ids0: np.ndarray | None = None

    for level in range(level_count):
        member = r0 < 4.0**-level
        if level > 0 and not member.any():
            break
        size = tile_size * 2**level
        nx = math.floor((x1 - x0) / size) + 1
        ny = math.floor((y1 - y0) / size) + 1
        tx = np.clip(((coords0[0][member] - x0) // size).astype(np.int64), 0, nx - 1)
        ty = np.clip(((coords0[1][member] - y0) // size).astype(np.int64), 0, ny - 1)
        tile = ty * nx + tx
        codes = codes0[member]
        rows = np.flatnonzero(member)

        if level == 0:
            # (tile, feature, r): any prefix of a (tile, feature) run is a uniform sample.
            order = np.lexsort((r0, codes, tile))
            ids0 = np.empty(n_points, dtype=np.uint64)
            ids0[order] = np.arange(n_points, dtype=np.uint64)
        else:
            # (tile, feature, id): coarser levels are samples already; rising ids
            # compress well.
            assert ids0 is not None
            order = np.lexsort((ids0[rows], codes, tile))
        tm_rows = rows[order]
        tm_tile = tile[order]
        tm_codes = codes[order]
        # Stable, so each (feature, tile) run keeps its tile_major order (spec §4).
        fm = np.lexsort((tm_tile, tm_codes))
        fm_rows = tm_rows[fm]
        fm_tile = tm_tile[fm]
        fm_codes = tm_codes[fm]
        n_tiles = nx * ny

        group = root.create_group(str(level))
        tile_major_columns = [
            *[(a, c[tm_rows]) for a, c in zip(axes, coords0)],
            (feature_key, tm_codes),
        ]
        if level > 0:
            # Optional in the spec (§4); level 0's row number is already the id. The
            # reference validator reads it to check that each level nests in the last.
            tile_major_columns.append(("id", ids0[tm_rows]))
        _write_dataframe(
            group.create_group("tile_major"),
            tile_major_columns,
            feature_key=feature_key,
            features=features,
            attrs={"points:order": "tile_major"},
            chunk_rows=chunk_rows,
            shard_chunks=shard_chunks,
        )
        _write_dataframe(
            group.create_group("feature_major"),
            [
                *[(a, c[fm_rows]) for a, c in zip(axes, coords0)],
                (feature_key, fm_codes),
                ("id", ids0[fm_rows]),
            ],
            feature_key=feature_key,
            features=features,
            attrs={"points:order": "feature_major", "points:copied_columns": []},
            chunk_rows=chunk_rows,
            shard_chunks=shard_chunks,
        )

        index = group.create_group("index")
        _write_index(index, "tile_rows", _offsets(np.bincount(tm_tile, minlength=n_tiles)), chunk_rows)
        _write_index(
            index, "feature_rows", _offsets(np.bincount(fm_codes, minlength=len(features))), chunk_rows
        )
        pair_keys, pair_counts = np.unique(
            fm_codes.astype(np.int64) * n_tiles + fm_tile, return_counts=True
        )
        pairs_per_feature = np.bincount(pair_keys // n_tiles, minlength=len(features))
        _write_index(index, "feature_tile_ptr", _offsets(pairs_per_feature), chunk_rows)
        _write_index(index, "feature_tile", (pair_keys % n_tiles).astype(np.uint32), chunk_rows)
        _write_index(index, "feature_tile_count", pair_counts.astype(np.uint32), chunk_rows)

        entry: dict[str, Any] = {
            "asset": str(level),
            "points:n_points": int(len(rows)),
            "points:grid": {"origin": [x0, y0], "tile_size": size, "shape": [ny, nx]},
        }
        if level > 0:
            entry |= {
                "derived_from": str(level - 1),
                "transform": {"scale": [1.0] * len(axes)},
                "resampling_method": "random",
            }
        layout.append(entry)

    axis_list = [{"name": a, "type": "space", "unit": units} for a in axes]
    root.attrs.update(
        {
            "encoding-type": "ngff:points",
            "axes": list(axes),
            "coordinateTransformations": transformations
            if transformations is not None
            else [
                {
                    "type": "identity",
                    "input": {"name": "".join(axes), "axes": axis_list},
                    "output": {"name": coordinate_system, "axes": axis_list},
                }
            ],
            "spatialdata_attrs": {"feature_key": feature_key, "version": "0.3-zarr"},
            "zarr_conventions": [_MULTISCALES_CONVENTION, _POINTS_CONVENTION],
            "multiscales": {"layout": layout},
            "points:version": POINTS_ZARR_VERSION,
            "points:units": units,
            "points:n_points": n_points,
            "points:extent": [extent_min, extent_max],
        }
    )
    return {
        "format": "points-zarr",
        "version": POINTS_ZARR_VERSION,
        "element": str(element_dir),
        "levels": [entry["points:n_points"] for entry in layout],
        "features": features,
    }


def write_points_zarr_store(
    df: pd.DataFrame,
    store_dir: str | Path,
    *,
    points_key: str = "transcripts",
    overwrite: bool = False,
    **kwargs: Any,
) -> dict[str, Any]:
    """Write a new store holding one points-zarr element at ``points/<points_key>``.

    The store gets consolidated metadata, which browser readers need to open it
    without listing. ``kwargs`` are :func:`write_points_zarr`'s.
    """
    store_dir = Path(store_dir)
    if store_dir.exists():
        if not overwrite:
            raise FileExistsError(f"{store_dir} exists; pass overwrite=True to replace it")
        shutil.rmtree(store_dir)
    root = zarr.open_group(store_dir, mode="w", zarr_format=3)
    root.attrs["spatialdata_attrs"] = {"version": "0.2"}
    root.create_group("points")
    summary = write_points_zarr(df, store_dir / "points" / points_key, **kwargs)
    zarr.consolidate_metadata(store_dir)
    return {**summary, "store": str(store_dir)}


def add_points_zarr_to_store(
    df: pd.DataFrame,
    store_dir: str | Path,
    *,
    points_key: str,
    overwrite: bool = False,
    **kwargs: Any,
) -> dict[str, Any]:
    """Add a points-zarr element at ``points/<points_key>`` of an existing store.

    spatialdata 0.8 cannot read a store holding such an element, so add it to a copy
    of a store, not to one other tools still read. When the store root has
    consolidated metadata, only the new element's nodes are merged into it; every
    other entry is left as it was. ``kwargs`` are :func:`write_points_zarr`'s.
    """
    store_dir = Path(store_dir)
    root_json = store_dir / "zarr.json"
    if not root_json.is_file():
        raise FileNotFoundError(f"No Zarr v3 store at {store_dir}")
    points_dir = store_dir / "points"
    if not (points_dir / "zarr.json").is_file():
        zarr.open_group(store_dir, mode="a", zarr_format=3).require_group("points")
    element_dir = points_dir / points_key
    summary = write_points_zarr(df, element_dir, overwrite=overwrite, **kwargs)

    root = json.loads(root_json.read_text())
    consolidated = root.get("consolidated_metadata")
    if consolidated is not None:
        prefix = f"points/{points_key}"
        metadata = {
            key: value
            for key, value in consolidated["metadata"].items()
            if key != prefix and not key.startswith(f"{prefix}/")
        }
        metadata.setdefault("points", json.loads((points_dir / "zarr.json").read_text()))
        for node in element_dir.rglob("zarr.json"):
            relative = node.parent.relative_to(element_dir).as_posix()
            key = prefix if relative == "." else f"{prefix}/{relative}"
            metadata[key] = json.loads(node.read_text())
        consolidated["metadata"] = dict(sorted(metadata.items()))
        root_json.write_text(json.dumps(root, indent=2, sort_keys=True))
    return {**summary, "store": str(store_dir), "consolidated": consolidated is not None}
