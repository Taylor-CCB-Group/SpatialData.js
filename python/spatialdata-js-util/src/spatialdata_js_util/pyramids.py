"""Add multiscale pyramids to raster elements whose coarsest level is too large.

Acquisition output is often written at a single resolution, or with only one or
two overviews. A browser then has no choice but to fetch near-full-resolution
chunks no matter how far out the user is zoomed, which is exactly the cost this
package exists to avoid — so a store without a deep enough pyramid defeats the
image codecs rather than complementing them.

An element needs work when the largest spatial axis of its *coarsest* level is
bigger than `min_size` (see `needs_pyramid`); a single-level element is just the
case where the coarsest level is full resolution. With an explicit level count,
an element needs work when it has fewer levels than asked for.

Levels are generated through SpatialData's own parsers rather than by writing
`multiscales` metadata by hand. Each level carries a scale *and* a half-pixel
translation (`s1` is offset by 0.5, `s2` by 1.5, …); getting those wrong
misaligns every level against the full-resolution image, and the parsers already
know the rule. A single-level element is parsed with scale factors; a shallow
pyramid keeps its existing levels and gains new ones parsed from its coarsest
level, with the per-level transforms rederived from level shapes as SpatialData
does for any multiscale. Extending reads only the coarsest level, not `s0`;
`force` rebuilds every level from full resolution instead. Images are coarsened
by averaging, labels by the label model's own downsampler, so label ids are never
blended into ones that never existed.

Three entry points apply the rule:

* `ensure_pyramids` works on an in-memory `SpatialData` and writes nothing, for a
  caller that is about to write it anyway.
* `add_pyramids_in_place` appends the missing levels to an existing store. Adding
  levels deletes nothing, so it needs no copy: new arrays go beside the old ones
  and only the metadata that declares them changes. It cannot replace levels.
* `add_pyramids` (and `recompress_spatialdata(pyramid=True)`) write a *different*
  store, which is the only way to replace levels — SpatialData refuses to delete
  the files backing a live element — and is what `force` needs.
"""

from __future__ import annotations

import os
import shutil
from dataclasses import dataclass
from pathlib import Path
from typing import TYPE_CHECKING, Any, Literal, Sequence

from .errors import WriterCommandError
from .provenance import package_version
from .store import (
    consolidated_metadata_is_current,
    json_bytes,
    read_json,
    refresh_consolidated_metadata,
    write_json,
)

if TYPE_CHECKING:
    from spatialdata import SpatialData

RasterCollection = Literal["images", "labels"]

#: Stop halving once the largest spatial axis is no bigger than this. Matches the
#: default spatial chunk size, so the coarsest level is about one chunk.
DEFAULT_MIN_SIZE = 1024

#: Guard against pathological inputs generating an unbounded number of levels.
MAX_LEVELS = 12


@dataclass(frozen=True)
class PyramidResult:
    store_path: Path
    manifest_path: Path | None
    manifest: dict[str, Any]


def _multiscale_datasets(store_path: Path, collection: str, key: str) -> list[str]:
    """Return the dataset paths (`s0`, `s1`, …) declared by a raster group."""
    meta_path = store_path / collection / key / "zarr.json"
    if not meta_path.is_file():
        return []
    attrs = read_json(meta_path).get("attributes", {})
    ome = attrs.get("ome", attrs)
    if not isinstance(ome, dict):
        return []
    multiscales = ome.get("multiscales")
    if not multiscales:
        return []
    return [str(d["path"]) for d in multiscales[0].get("datasets", []) if "path" in d]


def has_pyramid(store_path: str | Path, collection: str, key: str) -> bool:
    """Whether a raster element already declares more than one resolution level."""
    return len(_multiscale_datasets(Path(store_path), collection, key)) > 1


def _spatial_extent(element: Any) -> tuple[int, ...]:
    """Sizes of the spatial axes (y/x, plus z when present)."""
    sizes = element.sizes
    return tuple(int(sizes[axis]) for axis in ("z", "y", "x") if axis in sizes)


def resolve_scale_factors(
    element: Any,
    *,
    levels: int | Literal["auto"] = "auto",
    downscale: int = 2,
    min_size: int = DEFAULT_MIN_SIZE,
) -> list[int]:
    """Return the per-step downscale factors to hand to a SpatialData parser.

    `levels` counts *total* resolutions including full res, so `levels=3` yields
    two factors and the levels `s0`, `s1`, `s2`. With ``"auto"``, halving
    continues until the largest spatial axis fits within *min_size*.
    """
    if downscale < 2:
        raise WriterCommandError(f"Pyramid downscale must be at least 2, got {downscale}.")

    extent = _spatial_extent(element)
    if not extent:
        return []

    if levels != "auto":
        if levels < 1:
            raise WriterCommandError(f"Pyramid levels must be at least 1, got {levels}.")
        # Silently capping an explicit request writes a pyramid the caller did not
        # ask for and reports success; the cap is only implicit for `"auto"`.
        if levels > MAX_LEVELS:
            raise WriterCommandError(
                f"Pyramid levels must be at most {MAX_LEVELS}, got {levels}."
            )
        return [downscale] * (int(levels) - 1)

    if min_size < 1:
        raise WriterCommandError(f"Pyramid min-size must be positive, got {min_size}.")

    factors: list[int] = []
    largest = max(extent)
    while largest > min_size and len(factors) < MAX_LEVELS - 1:
        # A further level would shrink an axis below one pixel.
        if min(extent) // (downscale ** (len(factors) + 1)) < 1:
            break
        factors.append(downscale)
        largest //= downscale
    return factors


def _level_arrays(element: Any) -> list[Any]:
    """Every resolution level of a raster, full resolution first."""
    from xarray import DataTree

    if isinstance(element, DataTree):
        return [element[name]["image"] for name in element]
    return [element]


def _full_resolution(element: Any) -> Any:
    """Return the full-resolution array, unwrapping an existing multiscale tree."""
    return _level_arrays(element)[0]


def needs_pyramid(element: Any, *, min_size: int = DEFAULT_MIN_SIZE) -> bool:
    """Whether a raster's coarsest level is still larger than *min_size*.

    *element* is an in-memory image or labels element, single- or multiscale.
    """
    return max(_spatial_extent(_level_arrays(element)[-1]), default=0) > min_size


PyramidAction = Literal["rebuilt", "extended", "skipped"]


def _plan(
    element: Any,
    *,
    levels: int | Literal["auto"],
    downscale: int,
    min_size: int,
    force: bool,
) -> tuple[PyramidAction, list[int], str | None]:
    """Decide how to give *element* the levels it lacks.

    Returns ``(action, scale_factors, skip_reason)``. ``"extended"`` keeps the
    levels that exist and adds new ones, with factors that apply to the coarsest
    existing level (for a single-level element that is full resolution).
    ``"rebuilt"`` recomputes every level from full resolution, and only happens
    under *force* on an element that already has several.
    """
    arrays = _level_arrays(element)
    if force or len(arrays) == 1:
        factors = resolve_scale_factors(
            arrays[0], levels=levels, downscale=downscale, min_size=min_size
        )
        if factors:
            return ("extended" if len(arrays) == 1 else "rebuilt"), factors, None
        return "skipped", [], (
            "already at or below the target size"
            if levels == "auto"
            else "requested a single level"
        )

    existing = len(arrays)
    if levels != "auto":
        if existing >= levels:
            return "skipped", [], f"already has {existing} levels"
        # Validates *levels*; the existing levels stand in for the first factors.
        factors = resolve_scale_factors(arrays[-1], levels=levels, downscale=downscale)
        return "extended", factors[existing - 1 :], None
    if not needs_pyramid(element, min_size=min_size):
        return "skipped", [], "coarsest level within min size"
    factors = resolve_scale_factors(arrays[-1], downscale=downscale, min_size=min_size)
    factors = factors[: MAX_LEVELS - existing]
    if not factors:
        # A very thin raster, or one already at MAX_LEVELS.
        return "skipped", [], "no further levels possible"
    return "extended", factors, None


def _rebuild_element(source_element: Any, scale_factors: list[int], chunks: Any) -> Any:
    from spatialdata.models import get_model

    model = get_model(source_element)
    # Transformations travel with the element; passing them again is an error.
    return model.parse(source_element, scale_factors=scale_factors, chunks=chunks)


def _extend_element(element: Any, scale_factors: list[int]) -> Any:
    """Append levels to a multiscale *element*, coarsened from its coarsest level.

    The existing levels are kept as they are. New levels come from the model's
    own parser, so images are averaged and labels keep valid ids.
    """
    from spatialdata.transformations import get_transformation, set_transformation

    # Private, but it is what `model.parse` runs on every multiscale it builds;
    # without it the new levels' coords are measured against the coarsest level.
    from spatialdata.transformations._utils import compute_coordinates
    from xarray import DataTree

    coarsest = _level_arrays(element)[-1]
    tail = _rebuild_element(coarsest, scale_factors, _element_chunks(coarsest))
    nodes = {name: element[name].to_dataset() for name in element}
    for index, name in enumerate(list(tail)[1:], start=len(nodes)):
        nodes[f"scale{index}"] = tail[name].to_dataset()
    extended = DataTree.from_dict(nodes)
    # SpatialData derives each level's scale from its shape relative to the one
    # above, which also yields the half-pixel translation once written.
    set_transformation(extended, get_transformation(element, get_all=True), set_all=True)
    return compute_coordinates(extended)


def _apply_plan(element: Any, action: PyramidAction, scale_factors: list[int]) -> Any:
    from xarray import DataTree

    if action == "extended" and isinstance(element, DataTree):
        return _extend_element(element, scale_factors)
    full_res = _full_resolution(element)
    return _rebuild_element(full_res, scale_factors, _element_chunks(full_res))


def _element_chunks(element: Any) -> tuple[int, ...] | None:
    data = getattr(element, "data", None)
    chunksize = getattr(data, "chunksize", None)
    return tuple(int(size) for size in chunksize) if chunksize else None


def build_pyramids_into(
    *,
    source_sdata: "SpatialData",
    dest_sdata: "SpatialData",
    keys: Sequence[str],
    collection: RasterCollection,
    levels: int | Literal["auto"] = "auto",
    downscale: int = 2,
    min_size: int = DEFAULT_MIN_SIZE,
    force: bool = False,
) -> list[dict[str, Any]]:
    """Give *keys* pyramids, reading from one store and writing to another.

    Only elements that need levels are touched, and a multiscale element is
    extended from its coarsest level; *force* rebuilds every element from full
    resolution instead (see the module docstring). `dest_sdata` must be backed
    by a different path than `source_sdata`. Returns one report per key,
    including skipped ones.
    """
    reports: list[dict[str, Any]] = []
    dest_path = Path(str(dest_sdata.path))
    dest_elements = getattr(dest_sdata, collection)
    source_elements = getattr(source_sdata, collection)

    for key in keys:
        source_element = source_elements[key]
        full_res = _full_resolution(source_element)
        action, scale_factors, skip_reason = _plan(
            source_element, levels=levels, downscale=downscale, min_size=min_size, force=force
        )
        if action == "skipped":
            reports.append(
                {
                    "path": f"{collection}/{key}",
                    "action": "skipped",
                    "reason": skip_reason,
                    "shape": list(full_res.shape),
                    "levels": _multiscale_datasets(dest_path, collection, key),
                }
            )
            continue

        dest_elements[key] = _apply_plan(source_element, action, scale_factors)
        dest_sdata.delete_element_from_disk(key)
        dest_sdata.write_element(key)

        reports.append(
            {
                "path": f"{collection}/{key}",
                "action": action,
                "shape": list(full_res.shape),
                "scale_factors": scale_factors,
                "levels": _multiscale_datasets(dest_path, collection, key),
            }
        )
    return reports


def _ensure_collection(
    sdata: "SpatialData",
    collection: RasterCollection,
    keys: Sequence[str] | None,
    *,
    downscale: int,
    min_size: int,
) -> list[dict[str, Any]]:
    elements = getattr(sdata, collection)
    available = list(elements.keys())
    if keys is None:
        keys = available
    unknown = [key for key in keys if key not in available]
    if unknown:
        raise WriterCommandError(
            f"Unknown {collection} element(s): {', '.join(unknown)}. "
            f"Available: {', '.join(available) or '(none)'}"
        )

    reports: list[dict[str, Any]] = []
    for key in keys:
        element = elements[key]
        full_res = _full_resolution(element)
        action, scale_factors, skip_reason = _plan(
            element, levels="auto", downscale=downscale, min_size=min_size, force=False
        )
        if action == "skipped":
            reports.append(
                {
                    "path": f"{collection}/{key}",
                    "action": "skipped",
                    "reason": skip_reason,
                    "shape": list(full_res.shape),
                    "level_count": len(_level_arrays(element)),
                }
            )
            continue

        updated = _apply_plan(element, action, scale_factors)
        elements[key] = updated
        reports.append(
            {
                "path": f"{collection}/{key}",
                "action": action,
                "shape": list(full_res.shape),
                "scale_factors": scale_factors,
                "level_count": len(_level_arrays(updated)),
            }
        )
    return reports


def ensure_pyramids(
    sdata: "SpatialData",
    *,
    include_labels: bool = False,
    min_size: int = DEFAULT_MIN_SIZE,
    downscale: int = 2,
    image_keys: Sequence[str] | None = None,
    label_keys: Sequence[str] | None = None,
) -> list[dict[str, Any]]:
    """Give raster elements of an in-memory `SpatialData` the levels they lack.

    Each image (and, with *include_labels*, each labels element) whose coarsest
    level is larger than *min_size* is replaced in `sdata` by one that keeps its
    existing levels and gains new ones coarsened from its coarsest level (for a
    single-level element, from full resolution). Nothing is written or
    recompressed; the new levels are lazy dask arrays computed when `sdata` is
    written. *image_keys* and *label_keys* limit which elements are
    considered.

    A replaced element still reads from the files backing the original, so
    write `sdata` to a new path: SpatialData refuses to delete files backing a
    live element.

    Returns one report per element considered: ``action`` is ``"extended"``
    (``scale_factors`` apply to the coarsest existing level) or ``"skipped"``
    (with a ``reason``), as from `build_pyramids_into`, except that
    ``level_count`` replaces the on-disk ``levels`` names.
    """
    reports = _ensure_collection(
        sdata, "images", image_keys, downscale=downscale, min_size=min_size
    )
    if include_labels:
        reports.extend(
            _ensure_collection(
                sdata, "labels", label_keys, downscale=downscale, min_size=min_size
            )
        )
    return reports


def _level_names(datasets: list[dict[str, Any]]) -> list[str]:
    return [str(dataset["path"]) for dataset in datasets]


def _plain_zarr_codecs(array: Any) -> bool:
    """Whether every codec of *array* ships with zarr or numcodecs.

    Levels added in place must stay readable by any zarr reader, so they never
    inherit an image codec (JPEG 2000, HTJ2K) from the level they were derived
    from.
    """
    codecs = [*array.filters, array.serializer, *array.compressors]
    return all(type(codec).__module__.split(".")[0] in {"zarr", "numcodecs"} for codec in codecs)


def _write_levels_in_place(
    store_path: Path,
    collection: RasterCollection,
    key: str,
    levels: Sequence[Any],
    shapes: list[tuple[int, ...]],
) -> None:
    """Append *levels* (lazy arrays) to an element group, then declare them.

    Arrays are written before the group metadata names them, so a run that dies
    part-way leaves undeclared arrays that the next run overwrites, never a
    pyramid that points at missing data. Nothing that already exists is touched
    except the group's `zarr.json`, which is replaced atomically.
    """
    import dask.array as da
    import zarr
    from ome_zarr.format import FormatV05
    from zarr.core.metadata import ArrayV3Metadata

    meta_path = store_path / collection / key / "zarr.json"
    doc = read_json(meta_path)
    if int(doc.get("zarr_format", 0)) != 3:
        raise WriterCommandError(f"{collection}/{key} is not a Zarr v3 group; cannot extend in place.")
    attrs = doc.get("attributes", {})
    multiscale = (attrs.get("ome", attrs).get("multiscales") or [None])[0]
    if multiscale is None:
        raise WriterCommandError(f"{collection}/{key} declares no multiscales metadata.")
    datasets: list[dict[str, Any]] = multiscale["datasets"]
    existing = len(datasets)
    names = _level_names(datasets)
    if existing + len(levels) != len(shapes):
        raise WriterCommandError(
            f"{collection}/{key} declares {existing} levels on disk, but {len(shapes) - len(levels)} "
            "when it was opened; it changed in between. Rerun."
        )
    if names != [f"s{i}" for i in range(existing)]:
        raise WriterCommandError(
            f"{collection}/{key} has levels named {names}; extending in place needs s0, s1, …"
        )

    # Level transforms are a function of the level shapes; SpatialData and
    # ome-zarr derive them the same way on every write. A store whose existing
    # entries disagree would get new levels that are misaligned against them.
    transforms = FormatV05().generate_coordinate_transformations(shapes)
    if transforms is None or not _same_transforms(
        [dataset["coordinateTransformations"] for dataset in datasets], transforms[:existing]
    ):
        raise WriterCommandError(
            f"{collection}/{key} has level transforms that do not follow its level shapes, "
            "so new levels cannot be appended consistently. Write to a new store instead."
        )

    # Opened as the element itself, not through the root: a nested listing left in
    # its zarr.json can predate the arrays beside it, and zarr would trust it.
    group = zarr.open_group(meta_path.parent, mode="r+", use_consolidated=False)
    template = group.get(names[-1])
    if not isinstance(template, zarr.Array):
        raise WriterCommandError(f"{collection}/{key} is not laid out as a multiscale image group.")
    template_meta = template.metadata
    if not isinstance(template_meta, ArrayV3Metadata):
        raise WriterCommandError(f"{collection}/{key}/{names[-1]} is not a Zarr v3 array.")
    codecs: dict[str, Any] = (
        {
            "filters": template.filters,
            "serializer": template.serializer,
            "compressors": template.compressors,
        }
        if _plain_zarr_codecs(template)
        else {}
    )
    targets = []
    for offset, level in enumerate(levels):
        targets.append(
            group.create_array(
                f"s{existing + offset}",
                shape=tuple(level.shape),
                dtype=level.dtype,
                chunks=tuple(min(c, s) for c, s in zip(template.chunks, level.shape)),
                fill_value=template.fill_value,
                dimension_names=template_meta.dimension_names,
                chunk_key_encoding=template_meta.chunk_key_encoding,
                overwrite=True,
                **codecs,
            )
        )
    # One call, so dask computes an intermediate level once for the levels above it.
    da.store(
        [level.data.rechunk(target.chunks) for level, target in zip(levels, targets)],
        targets,
        lock=False,
    )

    datasets.extend(
        {"path": f"s{existing + offset}", "coordinateTransformations": transforms[existing + offset]}
        for offset in range(len(levels))
    )
    # A nested listing would describe the levels as they were, and readers trust
    # it over the files; dropping it in the same write keeps this one atomic.
    doc.pop("consolidated_metadata", None)
    tmp_path = meta_path.with_name("zarr.json.tmp")
    tmp_path.write_bytes(json_bytes(doc))
    os.replace(tmp_path, meta_path)


def _same_transforms(declared: list[Any], expected: list[Any]) -> bool:
    import numpy as np

    if len(declared) != len(expected):
        return False
    for have, want in zip(declared, expected):
        if [t["type"] for t in have] != [t["type"] for t in want]:
            return False
        for a, b in zip(have, want):
            for field in ("scale", "translation"):
                if field in b and not np.allclose(a[field], b[field]):
                    return False
    return True


def _extend_collection_in_place(
    store_path: Path,
    sdata: "SpatialData",
    collection: RasterCollection,
    keys: Sequence[str],
    *,
    levels: int | Literal["auto"],
    downscale: int,
    min_size: int,
) -> list[dict[str, Any]]:
    elements = getattr(sdata, collection)
    reports: list[dict[str, Any]] = []
    for key in keys:
        element = elements[key]
        full_res = _full_resolution(element)
        action, scale_factors, skip_reason = _plan(
            element, levels=levels, downscale=downscale, min_size=min_size, force=False
        )
        if action == "skipped":
            reports.append(
                {
                    "path": f"{collection}/{key}",
                    "action": "skipped",
                    "reason": skip_reason,
                    "shape": list(full_res.shape),
                    "levels": _multiscale_datasets(store_path, collection, key),
                }
            )
            continue

        updated = _level_arrays(_apply_plan(element, action, scale_factors))
        existing = len(_level_arrays(element))
        _write_levels_in_place(
            store_path,
            collection,
            key,
            updated[existing:],
            [tuple(int(n) for n in level.shape) for level in updated],
        )
        reports.append(
            {
                "path": f"{collection}/{key}",
                "action": action,
                "shape": list(full_res.shape),
                "scale_factors": scale_factors,
                "levels": _multiscale_datasets(store_path, collection, key),
            }
        )
    return reports


def add_pyramids_in_place(
    store: str | Path,
    *,
    image_keys: Sequence[str] | None = None,
    label_keys: Sequence[str] | None = None,
    include_labels: bool = False,
    levels: int | Literal["auto"] = "auto",
    downscale: int = 2,
    min_size: int = DEFAULT_MIN_SIZE,
    manifest: bool = True,
) -> PyramidResult:
    """Append the pyramid levels a store's rasters lack, without copying it.

    The same rule as `add_pyramids`, applied to *store* itself: each raster whose
    coarsest level is larger than *min_size* (or that has fewer than *levels*)
    keeps every level it has and gains new ones coarsened from its coarsest
    level, with a single-level raster coarsened from full resolution. Existing
    arrays are never rewritten or deleted, and so are not recompressed; only the
    element's group `zarr.json` and the store's consolidated metadata change.
    Levels added here use zarr's own codecs — the coarsest level's if they are
    plain zarr codecs, zarr's defaults if it uses an image codec — so they stay
    readable by any zarr reader.

    There is no *force*: replacing levels that exist means deleting files that
    back them. Use `add_pyramids` for that, or when the store's existing levels
    carry transforms that do not follow their shapes (this raises rather than
    append levels that would be misaligned).

    New arrays are written before the metadata that declares them, so an
    interrupted run leaves a store that still reads as it did and that a rerun
    completes. Do not run it while something else is writing the store.
    """
    import spatialdata as sd

    store_path = Path(store)
    if not (store_path / "zarr.json").is_file():
        raise WriterCommandError(f"Not a zarr store (no zarr.json): {store_path}")

    image_selection = _select_keys(store_path, "images", image_keys)
    label_selection = _select_keys(store_path, "labels", label_keys) if include_labels else []
    # Elements are opened lazily; tables and points are not read. read_zarr annotates
    # `selection` as a 1-tuple but builds a set from it, so any length works.
    selection = ("images", "labels") if include_labels else ("images",)
    sdata = sd.read_zarr(store_path, selection=selection)  # pyright: ignore[reportArgumentType]

    reports = _extend_collection_in_place(
        store_path, sdata, "images", image_selection,
        levels=levels, downscale=downscale, min_size=min_size,
    )
    if include_labels:
        reports.extend(
            _extend_collection_in_place(
                store_path, sdata, "labels", label_selection,
                levels=levels, downscale=downscale, min_size=min_size,
            )
        )
    # Refreshed once, not per element: it walks the whole store. A run that finds
    # nothing to do still heals a listing left behind by one that was interrupted,
    # and otherwise leaves the store byte-for-byte as it was.
    if any(
        report["action"] != "skipped" for report in reports
    ) or not consolidated_metadata_is_current(store_path):
        refresh_consolidated_metadata(store_path)

    manifest_data = {
        "format": "spatialdata-pyramids/v1",
        "source": str(store_path),
        "output": str(store_path),
        "in_place": True,
        "levels": levels,
        "downscale": downscale,
        "min_size": min_size,
        "rasters": reports,
        "packages": {
            "spatialdata": package_version("spatialdata"),
            "spatialdata-js-util": package_version("spatialdata-js-util"),
            "zarr": package_version("zarr"),
        },
    }
    manifest_path = store_path.with_suffix(".pyramid-manifest.json") if manifest else None
    if manifest_path is not None:
        write_json(manifest_path, manifest_data)
    return PyramidResult(store_path, manifest_path, manifest_data)


def _select_keys(
    store_path: Path, collection: RasterCollection, requested: Sequence[str] | None
) -> list[str]:
    from .store import list_element_keys

    available = list_element_keys(store_path, collection)
    if requested is None:
        return available
    unknown = [key for key in requested if key not in available]
    if unknown:
        raise WriterCommandError(
            f"Unknown {collection} element(s): {', '.join(unknown)}. "
            f"Available: {', '.join(available) or '(none)'}"
        )
    return list(requested)


def add_pyramids(
    source: str | Path,
    dest: str | Path,
    *,
    image_keys: Sequence[str] | None = None,
    label_keys: Sequence[str] | None = None,
    include_labels: bool = False,
    levels: int | Literal["auto"] = "auto",
    downscale: int = 2,
    min_size: int = DEFAULT_MIN_SIZE,
    force: bool = False,
    overwrite: bool = False,
    manifest: bool = True,
) -> PyramidResult:
    """Copy a store and give its raster elements multiscale pyramids.

    Only elements that need more levels are touched, unless *force* is set; see
    the module docstring for the rule. Everything the store contains that is not being rebuilt — points,
    shapes, tables, other rasters — is preserved by the copy.
    """
    import spatialdata as sd

    source_path = Path(source)
    dest_path = Path(dest)
    if not (source_path / "zarr.json").is_file():
        raise WriterCommandError(f"Not a zarr store (no zarr.json): {source_path}")
    if dest_path.resolve() == source_path.resolve():
        raise WriterCommandError(
            "Pyramids must be written to a different store than the source: SpatialData "
            "refuses to delete the files backing a live element."
        )
    if dest_path.exists():
        if not overwrite:
            raise WriterCommandError(
                f"Destination already exists: {dest_path}\nPass overwrite to replace it."
            )
        shutil.rmtree(dest_path)
    shutil.copytree(source_path, dest_path)

    source_sdata = sd.read_zarr(source_path)
    dest_sdata = sd.read_zarr(dest_path)

    reports = build_pyramids_into(
        source_sdata=source_sdata,
        dest_sdata=dest_sdata,
        keys=_select_keys(dest_path, "images", image_keys),
        collection="images",
        levels=levels,
        downscale=downscale,
        min_size=min_size,
        force=force,
    )
    if include_labels:
        reports.extend(
            build_pyramids_into(
                source_sdata=source_sdata,
                dest_sdata=dest_sdata,
                keys=_select_keys(dest_path, "labels", label_keys),
                collection="labels",
                levels=levels,
                downscale=downscale,
                min_size=min_size,
                force=force,
            )
        )

    refresh_consolidated_metadata(dest_path)

    manifest_data = {
        "format": "spatialdata-pyramids/v1",
        "source": str(source_path),
        "output": str(dest_path),
        "levels": levels,
        "downscale": downscale,
        "min_size": min_size,
        "rasters": reports,
        "packages": {
            "spatialdata": package_version("spatialdata"),
            "spatialdata-js-util": package_version("spatialdata-js-util"),
            "zarr": package_version("zarr"),
        },
    }
    manifest_path = dest_path.with_suffix(".pyramid-manifest.json") if manifest else None
    if manifest_path is not None:
        write_json(manifest_path, manifest_data)
    return PyramidResult(dest_path, manifest_path, manifest_data)
