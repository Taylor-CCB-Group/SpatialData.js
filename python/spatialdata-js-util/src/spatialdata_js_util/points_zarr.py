"""Write points in the multiscale Zarr layout of merfisheyes' points-zarr spec 0.1.

https://github.com/kresnajenie/merfisheyes/blob/main/docs/points-zarr-spec.md

A points element becomes a Zarr v3 group of levels. Level 0 holds every point and
each further level a uniform random quarter of the one below. Every level stores the
points twice: ``tile_major`` (sorted by tile, then feature) for "everything in this
region" and ``feature_major`` (sorted by feature, then tile) for "this feature
anywhere". An ``index`` of row numbers says where each tile's and each feature's
rows are, so a reader plans a read from counts before fetching any point.

Experimental: the spec is one group's draft, built on maturity-0 zarr conventions.
Its group declares ``spatialdata_attrs.version`` ``0.3-zarr``, which spatialdata 0.8
fails on, so stores here keep it beside a standard element rather than in its place
(ADR 0006): ``points/<key>/`` stays an ordinary SpatialData points element with its
``points.parquet``, and the points-zarr group is its ``experimental.points-zarr``
subgroup, which standard readers ignore. :func:`write_points_zarr_store` writes both;
:func:`add_points_zarr_to_store` adds the copy to an existing element.

The writer works out of core, so the input may be far larger than memory:

1. **Survey**: one pass over the input for the extent, the point count and the
   feature names.
2. **Spill**: a second pass writes the points to temporary files, one per horizontal
   band of whole level-0 tile rows, with each point's uniform draw ``r`` (its level
   membership) beside it.
3. **Per level**: whole tile rows are loaded a group of bands at a time, sorted, and
   appended to ``tile_major``; tile ids increase with the row, so appending groups in
   order keeps the whole level sorted. Each group's ``feature_major`` run is spilled
   with per-feature offsets, then gathered feature by feature across groups, which
   keeps the (feature, tile) order.

Arrays are written a whole shard at a time, so nothing is read back and rewritten.
"""

from __future__ import annotations

import json
import math
import shutil
import tempfile
from collections.abc import Callable, Iterable
from pathlib import Path
from typing import Any, Sequence

import numpy as np
import pandas as pd
import pyarrow as pa
import pyarrow.dataset as ds
import pyarrow.parquet as pq
import zarr
from zarr.codecs import BloscCodec

POINTS_ZARR_VERSION = "0.1"
#: The points-zarr copy's subgroup in a standard points element (ADR 0006).
SIDECAR_GROUP = "experimental.points-zarr"
#: Rows per chunk of a point column, and chunks per shard: the reference writer's.
DEFAULT_CHUNK_ROWS = 65_536
DEFAULT_SHARD_CHUNKS = 64
#: Levels are added until one holds no more than this many points (spec §3).
COARSEST_LEVEL_TARGET = 1_000_000
#: Points a spill band may be expected to hold. A level-0 band is sorted in memory,
#: at roughly 70 bytes a point including the sort's temporaries.
DEFAULT_BAND_POINTS = 50_000_000

#: A re-iterable source of points: each call yields the same frames, in the same
#: order. A frame may be one tile of a converter's input, or the whole input.
PointsSource = Callable[[], Iterable[pd.DataFrame]]

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


def _write_strings(group: zarr.Group, name: str, values: Sequence[str]) -> None:
    # Variable-length UTF-8 (`string`), as the spec's readers expect; numpy's `str`
    # would be written as fixed-length UTF-32.
    group.create_array(name, data=np.asarray(list(values), dtype=np.dtypes.StringDType()))


class _ShardWriter:
    """Fills a 1-D sharded array front to back, writing only whole shards until the end.

    zarr rewrites a shard that a write covers partly; buffering to shard boundaries
    keeps every write a single, final one.
    """

    def __init__(
        self, group: zarr.Group, name: str, n_rows: int, dtype: Any, chunk_rows: int, shard_chunks: int
    ):
        chunk = max(1, min(chunk_rows, n_rows))
        self.shard_rows = chunk * shard_chunks
        self.array = group.create_array(
            name,
            shape=(n_rows,),
            dtype=dtype,
            chunks=(chunk,),
            shards=(self.shard_rows,),
            compressors=_compressor(np.dtype(dtype)),
            fill_value=0,
        )
        self.dtype = np.dtype(dtype)
        self.position = 0
        self.pending: list[np.ndarray] = []
        self.pending_rows = 0

    def append(self, values: np.ndarray) -> None:
        if len(values) == 0:
            return
        self.pending.append(np.asarray(values, dtype=self.dtype))
        self.pending_rows += len(values)
        if self.pending_rows >= self.shard_rows:
            self._flush(final=False)

    def _flush(self, final: bool) -> None:
        data = self.pending[0] if len(self.pending) == 1 else np.concatenate(self.pending)
        whole = len(data) if final else len(data) // self.shard_rows * self.shard_rows
        if whole:
            self.array[self.position : self.position + whole] = data[:whole]
            self.position += whole
        rest = data[whole:]
        self.pending = [rest.copy()] if len(rest) else []
        self.pending_rows = len(rest)

    def close(self) -> None:
        if self.pending_rows:
            self._flush(final=True)
        if self.position != self.array.shape[0]:
            raise RuntimeError(
                f"{self.array.path}: wrote {self.position} of {self.array.shape[0]} rows"
            )


def _create_dataframe(
    group: zarr.Group,
    columns: list[tuple[str, Any]],
    n_rows: int,
    *,
    feature_key: str,
    features: Sequence[str],
    attrs: dict[str, Any],
    chunk_rows: int,
    shard_chunks: int,
) -> dict[str, _ShardWriter]:
    """One row order, in the `df:` convention, the feature column as an `enum:`."""
    group.attrs.update(
        {"zarr_conventions": [_DATAFRAME_CONVENTION], "df:shape": [n_rows, len(columns)], **attrs}
    )
    _write_strings(group, "columns", [name for name, _ in columns])
    writers: dict[str, _ShardWriter] = {}
    for i, (name, dtype) in enumerate(columns):
        member = f"column_{i}"
        if name == feature_key:
            enum = group.create_group(member)
            enum.attrs.update(
                {"zarr_conventions": [_ENUM_CONVENTION], "enum:ordered": False, "enum:codes": ["codes"]}
            )
            _write_strings(enum, "enum_values", features)
            writers[name] = _ShardWriter(enum, "codes", n_rows, dtype, chunk_rows, shard_chunks)
        else:
            writers[name] = _ShardWriter(group, member, n_rows, dtype, chunk_rows, shard_chunks)
    return writers


def _write_index(
    group: zarr.Group, name: str, data: np.ndarray, chunk_rows: int, shard_chunks: int
) -> None:
    writer = _ShardWriter(group, name, len(data), data.dtype, chunk_rows, shard_chunks)
    writer.append(data)
    writer.close()


def _offsets(counts: np.ndarray) -> np.ndarray:
    """Run starts from run lengths, with the total appended: the index's row form."""
    return np.concatenate(([0], np.cumsum(counts))).astype(np.uint64)


def _default_level_count(n_points: int) -> int:
    if n_points <= COARSEST_LEVEL_TARGET:
        return 1
    return 1 + math.ceil(math.log(n_points / COARSEST_LEVEL_TARGET, 4))


class _Survey:
    """What the first pass learns: extent, count and the feature names in order."""

    def __init__(self, dims: int):
        self.lo = np.full(dims, np.inf)
        self.hi = np.full(dims, -np.inf)
        self.n_points = 0
        self.names: dict[str, None] = {}
        self.all_categorical = True

    def add(self, coords: list[np.ndarray], feature: pd.Series, feature_key: str) -> None:
        if len(feature) == 0:
            return
        if feature.isna().any():
            raise ValueError(f"Column {feature_key!r} has missing values")
        for d, c in enumerate(coords):
            self.lo[d] = min(self.lo[d], float(c.min()))
            self.hi[d] = max(self.hi[d], float(c.max()))
        self.n_points += len(feature)
        if isinstance(feature.dtype, pd.CategoricalDtype):
            names = feature.cat.categories
        else:
            self.all_categorical = False
            names = pd.unique(feature)
        for name in names:
            self.names.setdefault(str(name), None)

    def features(self) -> list[str]:
        # A categorical's own order is kept; otherwise names are sorted, as
        # `pd.Categorical` would.
        return list(self.names) if self.all_categorical else sorted(self.names)


def _feature_codes(feature: pd.Series, code_of: pd.Index) -> np.ndarray:
    """Each row's index in the feature list, matched by name."""
    if isinstance(feature.dtype, pd.CategoricalDtype):
        # Map the categories once, not every row's string.
        by_category = code_of.get_indexer(feature.cat.categories.astype(str))
        codes = by_category[feature.cat.codes.to_numpy()]
    else:
        codes = code_of.get_indexer(feature.astype(str))
    if (codes < 0).any():
        unknown = sorted(set(feature.astype(str).to_numpy()[codes < 0]))[:5]
        raise ValueError(f"Features not in the feature list: {unknown}")
    return codes


def write_points_zarr(
    data: pd.DataFrame | PointsSource,
    element_dir: str | Path,
    *,
    feature_key: str,
    coordinates: Sequence[str] = ("x", "y"),
    features: Sequence[str] | None = None,
    tile_size: float = 100.0,
    n_levels: int | None = None,
    seed: int = 0,
    units: str = "micrometer",
    coordinate_system: str = "global",
    transformations: list[dict[str, Any]] | None = None,
    chunk_rows: int = DEFAULT_CHUNK_ROWS,
    shard_chunks: int = DEFAULT_SHARD_CHUNKS,
    band_points: int = DEFAULT_BAND_POINTS,
    work_dir: str | Path | None = None,
    progress: Callable[[str], None] | None = None,
    overwrite: bool = False,
) -> dict[str, Any]:
    """Write points as a points-zarr element group at ``element_dir``.

    ``data`` is a DataFrame, or a :data:`PointsSource` for input larger than memory
    (read twice: once to survey, once to spill). ``coordinates`` name the coordinate
    columns, two or three, written as axes ``x``, ``y`` and ``z`` in that order;
    ``feature_key`` names the feature column. Categorical input keeps its categories,
    in order, as the feature list; other input is listed in sorted order; pass
    ``features`` to fix it. Every listed feature appears in the store, with or
    without points.

    Levels are added until one holds about a million points unless ``n_levels`` is
    given, stopping early at a level that would be empty. ``seed`` fixes the random
    sample, so a rerun on the same input writes the same rows.

    ``transformations`` are written as the element's ``coordinateTransformations``,
    so an element converted from another keeps its placement (copy them from the
    source element's attrs); by default, identity into ``coordinate_system``.

    Temporary files go under ``work_dir`` (a new directory beside ``element_dir`` by
    default): about 18 bytes a point while spilling, plus one level's sorted copy.
    ``band_points`` bounds the points sorted at once, and so the memory used.

    Returns a summary: point counts per level and the feature list.
    """
    element_dir = Path(element_dir)
    source: PointsSource = (lambda: [data]) if isinstance(data, pd.DataFrame) else data
    say = progress or (lambda _message: None)
    if not 2 <= len(coordinates) <= 3:
        raise ValueError(f"coordinates must name two or three columns, got {list(coordinates)}")
    if element_dir.exists() and not overwrite:
        raise FileExistsError(f"{element_dir} exists; pass overwrite=True to replace it")
    element_dir.parent.mkdir(parents=True, exist_ok=True)
    dims = len(coordinates)
    axes = ("x", "y", "z")[:dims]

    def frames():
        for frame in source():
            missing = [c for c in (*coordinates, feature_key) if c not in frame.columns]
            if missing:
                raise ValueError(f"Missing columns: {', '.join(missing)}")
            yield [frame[c].to_numpy(dtype=np.float32) for c in coordinates], frame[feature_key]

    say("surveying")
    survey = _Survey(dims)
    for coords, feature in frames():
        survey.add(coords, feature, feature_key)
    if survey.n_points == 0:
        raise ValueError("No points to write")
    feature_list = [str(f) for f in features] if features is not None else survey.features()
    code_of = pd.Index(feature_list)
    code_dtype = np.uint16 if len(feature_list) <= np.iinfo(np.uint16).max + 1 else np.uint32
    n_points = survey.n_points
    extent_min, extent_max = [float(v) for v in survey.lo], [float(v) for v in survey.hi]
    x0, y0 = extent_min[:2]
    x1, y1 = extent_max[:2]
    level_count = n_levels if n_levels is not None else _default_level_count(n_points)

    def grid(level: int) -> tuple[float, int, int]:
        size = tile_size * 2**level
        return size, math.floor((x1 - x0) / size) + 1, math.floor((y1 - y0) / size) + 1

    # Bands of 2^j level-0 tile rows. A level-k tile row is 2^k level-0 rows, so for
    # k >= j it is 2^(k-j) whole bands, and for k < j a band holds whole level-k rows.
    _, _, ny0 = grid(0)
    rows_per_tile_row = n_points / ny0
    band_shift = 0
    # Twice the average, for uneven density across the section.
    while band_shift < level_count - 1 and 2 * rows_per_tile_row * 2 ** (band_shift + 1) <= band_points:
        band_shift += 1
    n_bands = math.ceil(ny0 / 2**band_shift)

    work = Path(work_dir) if work_dir is not None else Path(
        tempfile.mkdtemp(prefix=f".{element_dir.name}-", dir=element_dir.parent)
    )
    work.mkdir(parents=True, exist_ok=True)
    try:
        say(f"spilling {n_points:,} points into {n_bands} bands")
        spill_fields = [*[(a, np.float32) for a in axes], ("code", code_dtype), ("r", np.float32)]
        handles = {
            (b, name): open(work / f"band{b}.{name}", "wb")
            for b in range(n_bands)
            for name, _ in spill_fields
        }
        band_level_counts = np.zeros((n_bands, level_count), dtype=np.int64)
        thresholds = np.array([4.0**-k for k in range(level_count)], dtype=np.float32)
        try:
            for frame_index, (coords, feature) in enumerate(frames()):
                if len(feature) == 0:
                    continue
                codes = _feature_codes(feature, code_of)
                # One uniform draw per point; level k is every point with r < 4^-k.
                r = np.random.default_rng([seed, frame_index]).random(len(codes), dtype=np.float32)
                ty0 = np.clip(((coords[1] - y0) // tile_size).astype(np.int64), 0, ny0 - 1)
                band = ty0 >> band_shift
                order = np.argsort(band, kind="stable")
                starts = np.searchsorted(band[order], np.arange(n_bands + 1))
                columns = {**dict(zip(axes, coords)), "code": codes.astype(code_dtype), "r": r}
                for b in np.unique(band):
                    rows = order[starts[b] : starts[b + 1]]
                    for name, dtype in spill_fields:
                        handles[(b, name)].write(np.ascontiguousarray(columns[name][rows], dtype=dtype).tobytes())
                    band_level_counts[b] += (r[rows][:, None] < thresholds[None, :]).sum(axis=0)
        finally:
            for handle in handles.values():
                handle.close()

        level_sizes = band_level_counts.sum(axis=0)
        level_count = int(np.count_nonzero(level_sizes)) if level_sizes[-1] == 0 else level_count
        # Replaced only now that the input has been read and spilled, so a bad input
        # leaves the existing group as it was.
        if element_dir.exists():
            shutil.rmtree(element_dir)
        root = zarr.open_group(element_dir, mode="w", zarr_format=3)
        layout: list[dict[str, Any]] = []
        for level in range(level_count):
            layout.append(
                _write_level(
                    root,
                    level,
                    work=work,
                    n_rows=int(level_sizes[level]),
                    grid=grid(level),
                    origin=(x0, y0),
                    band_shift=band_shift,
                    n_bands=n_bands,
                    axes=axes,
                    spill_fields=spill_fields,
                    code_dtype=code_dtype,
                    feature_key=feature_key,
                    features=feature_list,
                    chunk_rows=chunk_rows,
                    shard_chunks=shard_chunks,
                    say=say,
                )
            )
    finally:
        if work_dir is None:
            shutil.rmtree(work, ignore_errors=True)

    root.attrs.update(
        {
            "encoding-type": "ngff:points",
            "axes": list(axes),
            "coordinateTransformations": transformations
            if transformations is not None
            else _identity_transform(axes, coordinate_system, units),
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
        "features": feature_list,
    }


def _write_level(
    root: zarr.Group,
    level: int,
    *,
    work: Path,
    n_rows: int,
    grid: tuple[float, int, int],
    origin: tuple[float, float],
    band_shift: int,
    n_bands: int,
    axes: Sequence[str],
    spill_fields: list[tuple[str, Any]],
    code_dtype: Any,
    feature_key: str,
    features: Sequence[str],
    chunk_rows: int,
    shard_chunks: int,
    say: Callable[[str], None],
) -> dict[str, Any]:
    size, nx, ny = grid
    x0, y0 = origin
    n_tiles = nx * ny
    n_features = len(features)
    threshold = np.float32(4.0**-level)
    # Whole level-k tile rows per group of bands; see the band comment above.
    group_bands = 2 ** max(0, level - band_shift)
    groups = [range(b, min(b + group_bands, n_bands)) for b in range(0, n_bands, group_bands)]
    say(f"level {level}: {n_rows:,} points, {len(groups)} groups")

    group = root.create_group(str(level))
    tm_columns = [*[(a, np.float32) for a in axes], (feature_key, code_dtype)]
    if level > 0:
        # Optional in the spec (§4); level 0's row number is already the id. The
        # reference validator reads it to check that each level nests in the last.
        tm_columns.append(("id", np.uint64))
    tile_major = _create_dataframe(
        group.create_group("tile_major"),
        tm_columns,
        n_rows,
        feature_key=feature_key,
        features=features,
        attrs={"points:order": "tile_major"},
        chunk_rows=chunk_rows,
        shard_chunks=shard_chunks,
    )
    tile_counts = np.zeros(n_tiles, dtype=np.int64)
    level_work = work / f"level{level}"
    level_work.mkdir()
    fm_fields = [*[(a, np.float32) for a in axes], ("id", np.uint64)]
    group_feature_offsets: list[np.ndarray] = []
    group_pair_offsets: list[np.ndarray] = []
    written = 0

    for g, bands in enumerate(groups):
        loaded = {
            name: np.concatenate([np.fromfile(work / f"band{b}.{name}", dtype=dtype) for b in bands])
            for name, dtype in spill_fields
        }
        if level == 0:
            ids = None
        else:
            ids = np.concatenate([np.fromfile(work / f"band{b}.id", dtype=np.uint64) for b in bands])
        member = loaded["r"] < threshold
        tx = np.clip(((loaded["x"][member] - x0) // size).astype(np.int64), 0, nx - 1)
        ty = np.clip(((loaded["y"][member] - y0) // size).astype(np.int64), 0, ny - 1)
        tile = ty * nx + tx
        codes = loaded["code"][member]
        if level == 0:
            # (tile, feature, r): any prefix of a (tile, feature) run is a uniform sample.
            order = np.lexsort((loaded["r"], codes, tile))
            # A point's id is its row in level-0 tile_major; kept per band, in spill
            # order, for the coarser levels to carry.
            ids = np.empty(len(codes), dtype=np.uint64)
            ids[order] = np.arange(written, written + len(codes), dtype=np.uint64)
            (band,) = bands
            ids.tofile(work / f"band{band}.id")
            member_ids = ids
        else:
            assert ids is not None
            member_ids = ids[member]
            # (tile, feature, id): coarser levels are samples already; rising ids
            # compress well.
            order = np.lexsort((member_ids, codes, tile))
        written += len(order)

        tm_tile = tile[order]
        tm_codes = codes[order]
        tm_ids = member_ids[order]
        tm_coords = {a: loaded[a][member][order] for a in axes}
        for a in axes:
            tile_major[a].append(tm_coords[a])
        tile_major[feature_key].append(tm_codes)
        if level > 0:
            tile_major["id"].append(tm_ids)
        tile_counts += np.bincount(tm_tile, minlength=n_tiles)

        # Stable, so each (feature, tile) run keeps its tile_major order (spec §4).
        fm = np.lexsort((tm_tile, tm_codes))
        fm_codes = tm_codes[fm]
        fm_tile = tm_tile[fm]
        for a in axes:
            tm_coords[a][fm].tofile(level_work / f"g{g}.{a}")
        tm_ids[fm].tofile(level_work / f"g{g}.id")
        group_feature_offsets.append(_offsets(np.bincount(fm_codes, minlength=n_features)))
        # Already sorted by (feature, tile): the pairs are its runs.
        keys = fm_codes.astype(np.int64) * n_tiles + fm_tile
        run_starts = np.flatnonzero(np.diff(keys, prepend=-1))
        pair_keys = keys[run_starts]
        pair_counts = np.diff(np.append(run_starts, len(keys)))
        (pair_keys % n_tiles).astype(np.uint32).tofile(level_work / f"g{g}.pair_tile")
        pair_counts.astype(np.uint32).tofile(level_work / f"g{g}.pair_count")
        group_pair_offsets.append(_offsets(np.bincount(pair_keys // n_tiles, minlength=n_features)))
        del loaded, ids, member, order, tm_coords

    for writer in tile_major.values():
        writer.close()

    feature_counts = np.sum([np.diff(o.astype(np.int64)) for o in group_feature_offsets], axis=0)
    pair_totals = np.sum([np.diff(o.astype(np.int64)) for o in group_pair_offsets], axis=0)
    n_pairs = int(pair_totals.sum())
    feature_major = _create_dataframe(
        group.create_group("feature_major"),
        [*[(a, np.float32) for a in axes], (feature_key, code_dtype), ("id", np.uint64)],
        n_rows,
        feature_key=feature_key,
        features=features,
        attrs={"points:order": "feature_major", "points:copied_columns": []},
        chunk_rows=chunk_rows,
        shard_chunks=shard_chunks,
    )
    index = group.create_group("index")
    pair_tile = _ShardWriter(index, "feature_tile", n_pairs, np.uint32, chunk_rows, shard_chunks)
    pair_count = _ShardWriter(index, "feature_tile_count", n_pairs, np.uint32, chunk_rows, shard_chunks)
    spilled = [
        {
            **{name: np.memmap(level_work / f"g{g}.{name}", dtype=dtype, mode="r")
               if (level_work / f"g{g}.{name}").stat().st_size else np.empty(0, dtype=dtype)
               for name, dtype in fm_fields},
            **{name: np.memmap(level_work / f"g{g}.{name}", dtype=np.uint32, mode="r")
               if (level_work / f"g{g}.{name}").stat().st_size else np.empty(0, dtype=np.uint32)
               for name in ("pair_tile", "pair_count")},
        }
        for g in range(len(groups))
    ]
    say(f"level {level}: gathering feature_major for {n_features:,} features")
    for f in range(n_features):
        if feature_counts[f] == 0:
            continue
        for g, columns in enumerate(spilled):
            lo, hi = int(group_feature_offsets[g][f]), int(group_feature_offsets[g][f + 1])
            if hi > lo:
                for name, _ in fm_fields:
                    feature_major[name].append(columns[name][lo:hi])
            plo, phi = int(group_pair_offsets[g][f]), int(group_pair_offsets[g][f + 1])
            if phi > plo:
                pair_tile.append(columns["pair_tile"][plo:phi])
                pair_count.append(columns["pair_count"][plo:phi])
        feature_major[feature_key].append(np.full(int(feature_counts[f]), f, dtype=code_dtype))
    for writer in (*feature_major.values(), pair_tile, pair_count):
        writer.close()
    del spilled
    shutil.rmtree(level_work, ignore_errors=True)

    _write_index(index, "tile_rows", _offsets(tile_counts), chunk_rows, shard_chunks)
    _write_index(index, "feature_rows", _offsets(feature_counts), chunk_rows, shard_chunks)
    _write_index(index, "feature_tile_ptr", _offsets(pair_totals), chunk_rows, shard_chunks)

    entry: dict[str, Any] = {
        "asset": str(level),
        "points:n_points": n_rows,
        "points:grid": {"origin": [x0, y0], "tile_size": size, "shape": [ny, nx]},
    }
    if level > 0:
        entry |= {
            "derived_from": str(level - 1),
            "transform": {"scale": [1.0] * len(axes)},
            "resampling_method": "random",
        }
    return entry


def _identity_transform(axes: Sequence[str], coordinate_system: str, units: str) -> list[dict[str, Any]]:
    axis_list = [{"name": a, "type": "space", "unit": units} for a in axes]
    return [
        {
            "type": "identity",
            "input": {"name": "".join(axes), "axes": axis_list},
            "output": {"name": coordinate_system, "axes": axis_list},
        }
    ]


def _write_standard_points(
    source: PointsSource,
    element_dir: Path,
    *,
    feature_key: str,
    coordinates: Sequence[str],
    features: Sequence[str],
    transformations: list[dict[str, Any]],
) -> int:
    """An ordinary SpatialData points element: ``points.parquet`` as parts, and attrs.

    Coordinates are written as ``x``, ``y`` (``z``), the feature column as a
    categorical over ``features`` so every part shares one dictionary.
    """
    axes = ("x", "y", "z")[: len(coordinates)]
    parquet_dir = element_dir / "points.parquet"
    parquet_dir.mkdir(parents=True)
    categories = pd.CategoricalDtype(list(features))
    parts = 0
    rows = 0
    for frame in source():
        if len(frame) == 0:
            continue
        # A RangeIndex continuing across parts, recorded in the pandas metadata rather
        # than as a column: the form pandas and dask write, and readers expect an index.
        table = pd.DataFrame(
            {
                **{a: frame[c].to_numpy(dtype=np.float32) for a, c in zip(axes, coordinates)},
                # An array, not a Series: a Series would be aligned to the index below
                # by label, emptying every part whose frame index restarts at 0.
                feature_key: pd.Categorical(frame[feature_key].astype(str), dtype=categories),
            },
            index=pd.RangeIndex(rows, rows + len(frame)),
        )
        pq.write_table(
            pa.Table.from_pandas(table),
            parquet_dir / f"part.{parts}.parquet",
            compression="zstd",
        )
        parts += 1
        rows += len(frame)
    group = zarr.open_group(element_dir, mode="a", zarr_format=3)
    group.attrs.update(
        {
            "encoding-type": "ngff:points",
            "axes": list(axes),
            "coordinateTransformations": transformations,
            "spatialdata_attrs": {"feature_key": feature_key, "version": "0.2"},
        }
    )
    return parts


def _merge_consolidated(store_dir: Path, group_dir: Path, prefix: str) -> bool:
    """Put ``group_dir``'s nodes into the root's consolidated metadata under ``prefix``,
    replacing what was there; leave every other entry as it was. False if the root has
    no consolidated metadata."""
    root_json = store_dir / "zarr.json"
    root = json.loads(root_json.read_text())
    consolidated = root.get("consolidated_metadata")
    if consolidated is None:
        return False
    metadata = {
        key: value
        for key, value in consolidated["metadata"].items()
        if key != prefix and not key.startswith(f"{prefix}/")
    }
    for node in group_dir.rglob("zarr.json"):
        if node.name.startswith("._"):
            continue
        relative = node.parent.relative_to(group_dir).as_posix()
        metadata[prefix if relative == "." else f"{prefix}/{relative}"] = json.loads(node.read_text())
    consolidated["metadata"] = dict(sorted(metadata.items()))
    root_json.write_text(json.dumps(root, indent=2, sort_keys=True))
    return True


def write_points_zarr_store(
    data: pd.DataFrame | PointsSource,
    store_dir: str | Path,
    *,
    points_key: str = "transcripts",
    feature_key: str,
    coordinates: Sequence[str] = ("x", "y"),
    units: str = "micrometer",
    coordinate_system: str = "global",
    transformations: list[dict[str, Any]] | None = None,
    overwrite: bool = False,
    **kwargs: Any,
) -> dict[str, Any]:
    """Write a new SpatialData store with one points element and its points-zarr copy.

    ``points/<points_key>`` is a standard element (``points.parquet`` and attrs) that
    any SpatialData reader opens; the points-zarr copy is its ``experimental.points-zarr``
    subgroup (ADR 0006). The store gets consolidated metadata, which browser readers
    need to open it without listing. Other ``kwargs`` are :func:`write_points_zarr`'s.
    """
    store_dir = Path(store_dir)
    if store_dir.exists():
        if not overwrite:
            raise FileExistsError(f"{store_dir} exists; pass overwrite=True to replace it")
        shutil.rmtree(store_dir)
    source: PointsSource = (lambda: [data]) if isinstance(data, pd.DataFrame) else data
    transforms = transformations or _identity_transform(
        ("x", "y", "z")[: len(coordinates)], coordinate_system, units
    )
    root = zarr.open_group(store_dir, mode="w", zarr_format=3)
    root.attrs["spatialdata_attrs"] = {"version": "0.2"}
    root.create_group("points")
    element_dir = store_dir / "points" / points_key
    summary = write_points_zarr(
        source,
        element_dir / SIDECAR_GROUP,
        feature_key=feature_key,
        coordinates=coordinates,
        units=units,
        transformations=transforms,
        **kwargs,
    )
    _write_standard_points(
        source,
        element_dir,
        feature_key=feature_key,
        coordinates=coordinates,
        features=summary["features"],
        transformations=transforms,
    )
    zarr.consolidate_metadata(store_dir)
    return {**summary, "store": str(store_dir)}


def add_points_zarr_to_store(
    data: pd.DataFrame | PointsSource | None,
    store_dir: str | Path,
    *,
    points_key: str,
    overwrite: bool = False,
    **kwargs: Any,
) -> dict[str, Any]:
    """Add a points-zarr copy beside the standard points element ``points/<points_key>``.

    The copy is written to the element's ``experimental.points-zarr`` subgroup, which
    standard readers ignore (ADR 0006). With ``data`` None it is read from the element's
    own ``points.parquet``, a batch at a time, with the element's axes, feature key and
    transformations. When the store root has consolidated metadata, only the copy's
    nodes are merged into it. ``kwargs`` are :func:`write_points_zarr`'s.
    """
    store_dir = Path(store_dir)
    element_dir = store_dir / "points" / points_key
    element_json = element_dir / "zarr.json"
    if not element_json.is_file():
        raise FileNotFoundError(f"No points element at {element_dir}")
    attrs = json.loads(element_json.read_text()).get("attributes", {})
    if "points:version" in attrs:
        raise ValueError(
            f"{element_dir} is itself a points-zarr element; there is no standard copy to add to"
        )
    if data is None:
        declared = (attrs.get("spatialdata_attrs") or {}).get("feature_key")
        if declared is None and "feature_key" not in kwargs:
            raise ValueError(
                f"{element_dir} declares no feature_key; points-zarr needs a feature column"
            )
        feature_key = kwargs.setdefault("feature_key", declared)
        coordinates = kwargs.setdefault("coordinates", tuple(attrs["axes"]))
        kwargs.setdefault("transformations", attrs.get("coordinateTransformations"))
        dataset = ds.dataset(element_dir / "points.parquet", format="parquet", exclude_invalid_files=True)
        columns = [*coordinates, feature_key]

        def parquet_frames() -> Iterable[pd.DataFrame]:
            for batch in dataset.to_batches(columns=columns, batch_size=4_000_000):
                yield batch.to_pandas()

        data = parquet_frames

    group_dir = element_dir / SIDECAR_GROUP
    summary = write_points_zarr(data, group_dir, overwrite=overwrite, **kwargs)
    consolidated = _merge_consolidated(store_dir, group_dir, f"points/{points_key}/{SIDECAR_GROUP}")
    return {**summary, "store": str(store_dir), "consolidated": consolidated}
