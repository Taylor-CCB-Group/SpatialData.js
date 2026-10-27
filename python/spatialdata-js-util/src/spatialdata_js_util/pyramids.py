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

`ensure_pyramids` does this in memory, for a caller that is about to write the
`SpatialData` object anyway. The path-based functions are copy-then-write: the
element is read from the source store and written into a *different* store,
because SpatialData refuses to delete the files backing a live element.
"""

from __future__ import annotations

import shutil
from dataclasses import dataclass
from pathlib import Path
from typing import TYPE_CHECKING, Any, Literal, Sequence

from .errors import WriterCommandError
from .provenance import package_version
from .store import read_json, refresh_consolidated_metadata, write_json

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

    Returns ``(action, scale_factors, skip_reason)``. Factors for ``"rebuilt"``
    apply to full resolution, factors for ``"extended"`` to the coarsest level.
    """
    arrays = _level_arrays(element)
    if force or len(arrays) == 1:
        factors = resolve_scale_factors(
            arrays[0], levels=levels, downscale=downscale, min_size=min_size
        )
        if factors:
            return "rebuilt", factors, None
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
    if action == "extended":
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
    level is larger than *min_size* is replaced in `sdata`. A multiscale element
    keeps its existing levels and gains new ones coarsened from its coarsest
    level; a single-level element is rebuilt from full resolution. Nothing is
    written or recompressed; the new levels are lazy dask arrays computed when
    `sdata` is written. *image_keys* and *label_keys* limit which elements are
    considered.

    A replaced element still reads from the files backing the original, so
    write `sdata` to a new path: SpatialData refuses to delete files backing a
    live element.

    Returns one report per element considered: ``action`` is ``"rebuilt"``,
    ``"extended"`` (``scale_factors`` then apply to the coarsest existing level)
    or ``"skipped"`` (with a ``reason``), as from `build_pyramids_into`, except
    that ``level_count`` replaces the on-disk ``levels`` names.
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
