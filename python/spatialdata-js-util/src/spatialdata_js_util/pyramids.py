"""Add multiscale pyramids to raster elements that lack them.

Acquisition output is often written at a single resolution. A browser then has no
choice but to fetch full-resolution chunks no matter how far out the user is
zoomed, which is exactly the cost this package exists to avoid — so a store
without a pyramid defeats the image codecs rather than complementing them.

Levels are generated through SpatialData's own parsers rather than by writing
`multiscales` metadata by hand. Each level carries a scale *and* a half-pixel
translation (`s1` is offset by 0.5, `s2` by 1.5, …); getting those wrong
misaligns every level against the full-resolution image, and the parsers already
know the rule. Images are coarsened by averaging, labels by the label model's own
downsampler, so label ids are never blended into ones that never existed.

Rebuilding is always copy-then-write: the element is read from the source store
and written into a *different* store. SpatialData refuses to delete the files
backing a live element, so genuine in-place rewriting is not available here.
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
        factors.append(downscale)
        largest //= downscale
        # A further level would shrink an axis below one pixel.
        if min(extent) // (downscale ** len(factors)) < 1:
            break
    return factors


def _full_resolution(element: Any) -> Any:
    """Return the full-resolution array, unwrapping an existing multiscale tree."""
    from xarray import DataTree

    if isinstance(element, DataTree):
        first = next(iter(element))
        return element[first]["image"]
    return element


def _rebuild_element(source_element: Any, scale_factors: list[int], chunks: Any) -> Any:
    from spatialdata.models import get_model

    model = get_model(source_element)
    # Transformations travel with the element; passing them again is an error.
    return model.parse(source_element, scale_factors=scale_factors, chunks=chunks)


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
    """Rebuild *keys* with pyramids, reading from one store and writing to another.

    `dest_sdata` must be backed by a different path than `source_sdata`; see the
    module docstring. Returns one report per key, including skipped ones.
    """
    reports: list[dict[str, Any]] = []
    dest_elements = getattr(dest_sdata, collection)
    source_elements = getattr(source_sdata, collection)

    for key in keys:
        source_element = source_elements[key]
        existing = _multiscale_datasets(Path(str(dest_sdata.path)), collection, key)
        if len(existing) > 1 and not force:
            reports.append(
                {
                    "path": f"{collection}/{key}",
                    "action": "skipped",
                    "reason": "already multiscale",
                    "levels": existing,
                }
            )
            continue

        full_res = _full_resolution(source_element)
        scale_factors = resolve_scale_factors(
            full_res, levels=levels, downscale=downscale, min_size=min_size
        )
        if not scale_factors:
            reports.append(
                {
                    "path": f"{collection}/{key}",
                    "action": "skipped",
                    "reason": (
                        "already at or below the target size"
                        if levels == "auto"
                        else "requested a single level"
                    ),
                    "shape": list(full_res.shape),
                }
            )
            continue

        rebuilt = _rebuild_element(full_res, scale_factors, _element_chunks(full_res))
        dest_elements[key] = rebuilt
        dest_sdata.delete_element_from_disk(key)
        dest_sdata.write_element(key)

        reports.append(
            {
                "path": f"{collection}/{key}",
                "action": "rebuilt",
                "shape": list(full_res.shape),
                "scale_factors": scale_factors,
                "levels": _multiscale_datasets(Path(str(dest_sdata.path)), collection, key),
            }
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

    Elements that already have more than one level are left alone unless *force*
    is set. Everything the store contains that is not being rebuilt — points,
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
