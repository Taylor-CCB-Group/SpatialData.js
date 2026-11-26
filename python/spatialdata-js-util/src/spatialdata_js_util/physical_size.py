"""Record each coordinate system's physical size in a SpatialData store's root attrs.

Most spatialdata-io stores write spatialdata's `"unit"` placeholder on every axis,
and the xenium/atera/merscope/visium_hd readers make `global` an image's pixel
grid, so a reader of the store cannot tell how long one coordinate-system unit is.
This writes the shared root attribute proposed in scverse/spatialdata-io#441::

    "physical_size": {"global": {"size": 0.2125, "unit": "micrometer"}}

Only attributes change: the root `zarr.json` (or `.zattrs` and `.zmetadata` in a
zarr v2 store). Why each size was chosen is recorded beside it, under
`spatialdata_js_util.physical_size`.
"""

from __future__ import annotations

import math
from collections.abc import Iterator, Mapping
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from .errors import WriterCommandError
from .provenance import package_version
from .store import read_json, write_json

PHYSICAL_SIZE_ATTR = "physical_size"
PROVENANCE_ATTR = "spatialdata_js_util"
FORMAT = "spatialdata-physical-size/v1"

#: spatialdata-io readers whose points and shapes are in µm, scaled by 1/pixel_size
#: into a coordinate system of morphology-image pixels.
MICRON_POINTS_READERS = frozenset({"xenium", "atera"})

# OME-NGFF space units; symbols people type are mapped onto them.
_NGFF_LENGTH_UNITS = frozenset(
    {
        "angstrom", "attometer", "centimeter", "decimeter", "exameter", "femtometer",
        "foot", "gigameter", "hectometer", "inch", "kilometer", "megameter", "meter",
        "micrometer", "mile", "millimeter", "nanometer", "parsec", "petameter",
        "picometer", "terameter", "yard", "yoctometer", "yottameter", "zeptometer",
        "zettameter",
    }
)
_UNIT_SYMBOLS = {
    "m": "meter", "cm": "centimeter", "mm": "millimeter", "µm": "micrometer",
    "μm": "micrometer", "um": "micrometer", "nm": "nanometer", "pm": "picometer",
    "Å": "angstrom", "in": "inch", "ft": "foot",
}

_SPATIAL_COLLECTIONS = ("images", "labels", "points", "shapes")


@dataclass(frozen=True)
class PhysicalSizeResult:
    store_path: Path
    #: The root `physical_size` attr after the run (what was written, or would be).
    physical_size: dict[str, dict[str, Any]]
    manifest: dict[str, Any]


def normalize_length_unit(unit: str) -> str:
    """The OME-NGFF name of a length unit given as a name or common symbol."""
    name = _UNIT_SYMBOLS.get(unit.strip(), unit.strip().lower())
    if name not in _NGFF_LENGTH_UNITS:
        raise WriterCommandError(f"Not a length unit: {unit!r}")
    return name


def record_physical_size(
    store: str | Path,
    *,
    sizes: Mapping[str, float] | None = None,
    unit: str = "micrometer",
    assume_reader: str | None = None,
    overwrite: bool = False,
    dry_run: bool = False,
) -> PhysicalSizeResult:
    """Write `physical_size` for the coordinate systems of *store*, in place.

    Each coordinate system's size comes from the first of:

    1. *sizes*, an explicit size in *unit* per coordinate system;
    2. the xenium/atera reader convention: one unit is 1/scale µm, where scale is
       the uniform xy scale every points and shapes element shares into it. The
       reader comes from the store's `spatialdata_io_reader` attr, or from
       *assume_reader* for stores written before spatialdata-io 0.7.0, which lack it;
    3. for atera, the reader's `pixel_size` attr (µm per `global` unit).

    An existing entry is kept unless an explicit size names its coordinate system
    or *overwrite* is set.
    """
    store_path = Path(store)
    root = _RootAttrs.open(store_path)
    attrs = root.attrs
    transforms = _transforms_by_coordinate_system(store_path)

    explicit_unit = normalize_length_unit(unit)
    unknown = sorted(set(sizes or {}) - set(transforms))
    if unknown:
        raise WriterCommandError(
            f"Unknown coordinate system(s): {', '.join(unknown)}. "
            f"Available: {', '.join(sorted(transforms)) or '(none)'}"
        )

    stored_reader = attrs.get("spatialdata_io_reader")
    reader = stored_reader if isinstance(stored_reader, str) else assume_reader
    reader_from = "spatialdata_io_reader" if isinstance(stored_reader, str) else "assumed"
    if assume_reader is not None and isinstance(stored_reader, str) and stored_reader != assume_reader:
        raise WriterCommandError(
            f"Store says it was written by the {stored_reader!r} reader, not {assume_reader!r}."
        )

    existing = attrs.get(PHYSICAL_SIZE_ATTR)
    physical_size: dict[str, dict[str, Any]] = dict(existing) if isinstance(existing, dict) else {}
    tool_attrs = attrs.get(PROVENANCE_ATTR)
    tool_attrs = dict(tool_attrs) if isinstance(tool_attrs, dict) else {}
    previous = tool_attrs.get(PHYSICAL_SIZE_ATTR)
    previous = previous.get("coordinate_systems") if isinstance(previous, dict) else None
    provenance: dict[str, Any] = dict(previous) if isinstance(previous, dict) else {}
    report: dict[str, dict[str, Any]] = {}

    for coordinate_system in sorted(transforms):
        explicit = (sizes or {}).get(coordinate_system)
        if explicit is not None:
            if not (math.isfinite(explicit) and explicit > 0):
                raise WriterCommandError(f"Size must be positive: {coordinate_system}={explicit}")
            entry, why = {"size": explicit, "unit": explicit_unit}, {"source": "explicit"}
        elif coordinate_system in physical_size and not overwrite:
            report[coordinate_system] = {"action": "kept", **physical_size[coordinate_system]}
            continue
        else:
            entry, why = _inferred(attrs, reader, coordinate_system, transforms[coordinate_system])
            if entry is None:
                report[coordinate_system] = {"action": "skipped", "reason": why}
                continue
            why["reader_from"] = reader_from
        physical_size[coordinate_system] = entry
        provenance[coordinate_system] = why
        report[coordinate_system] = {"action": "recorded", **entry, **why}

    recorded = any(item["action"] == "recorded" for item in report.values())
    manifest = {
        "format": FORMAT,
        "store": str(store_path),
        "dry_run": dry_run,
        "coordinate_systems": report,
        "packages": {"spatialdata-js-util": package_version("spatialdata-js-util")},
    }
    if recorded and not dry_run:
        attrs[PHYSICAL_SIZE_ATTR] = physical_size
        tool_attrs[PHYSICAL_SIZE_ATTR] = {
            "format": FORMAT,
            "coordinate_systems": provenance,
            "packages": manifest["packages"],
        }
        attrs[PROVENANCE_ATTR] = tool_attrs
        root.save()
    return PhysicalSizeResult(store_path, physical_size, manifest)


def _inferred(
    attrs: Mapping[str, Any],
    reader: str | None,
    coordinate_system: str,
    transforms: list[tuple[str, dict[str, Any]]],
) -> tuple[dict[str, Any] | None, dict[str, Any] | str]:
    """A size from the reader convention, else atera's `pixel_size`; or why there is none."""
    if reader not in MICRON_POINTS_READERS:
        if reader is None:
            return None, (
                "no size given, and no spatialdata_io_reader attr; pass assume_reader "
                "if a xenium or atera reader wrote it"
            )
        return None, f"no size given, and no known convention for the {reader!r} reader"

    scale, why_not = _shared_points_shapes_scale(transforms)
    if scale is not None:
        size = float(f"{1 / scale:.12g}")
        elements = sorted(path for path, _ in transforms if path.split("/")[0] in ("points", "shapes"))
        return {"size": size, "unit": "micrometer"}, {
            "source": "reader-convention",
            "reader": reader,
            "scale": scale,
            "elements": elements,
        }

    pixel_size = attrs.get("pixel_size")
    if reader == "atera" and coordinate_system == "global" and _is_positive_number(pixel_size):
        return {"size": float(pixel_size), "unit": "micrometer"}, {
            "source": "pixel_size-attr",
            "reader": reader,
            "pixel_size": pixel_size,
        }
    return None, why_not


def _shared_points_shapes_scale(
    transforms: list[tuple[str, dict[str, Any]]],
) -> tuple[float | None, str]:
    scales: set[float] = set()
    for path, transform in transforms:
        if path.split("/")[0] not in ("points", "shapes"):
            continue
        matrix = _xy_affine(transform)
        if matrix is None:
            return None, f"{path}: cannot read its transformation"
        (sx, shear_xy, _), (shear_yx, sy, _) = matrix
        if shear_xy != 0 or shear_yx != 0 or not math.isclose(sx, sy, rel_tol=1e-9) or sx <= 0:
            return None, f"{path}: not a uniform xy scale"
        scales.add(sx)
    if not scales:
        return None, "no points or shapes in this coordinate system"
    first = next(iter(scales))
    if any(not math.isclose(first, other, rel_tol=1e-9) for other in scales):
        return None, "points and shapes are scaled differently"
    return first, ""


def _is_positive_number(value: Any) -> bool:
    return (
        isinstance(value, (int, float))
        and not isinstance(value, bool)
        and math.isfinite(value)
        and value > 0
    )


# --------------------------------------------------------------------------- transforms

_Affine = tuple[tuple[float, float, float], tuple[float, float, float]]
_IDENTITY: _Affine = ((1.0, 0.0, 0.0), (0.0, 1.0, 0.0))


def _axis_names(space: Any) -> list[str] | None:
    axes = space.get("axes") if isinstance(space, dict) else None
    if not isinstance(axes, list):
        return None
    return [axis.get("name") if isinstance(axis, dict) else axis for axis in axes]


def _compose(outer: _Affine, inner: _Affine) -> _Affine:
    (a, b, c), (d, e, f) = outer
    (g, h, i), (j, k, l) = inner
    return (
        (a * g + b * j, a * h + b * k, a * i + b * l + c),
        (d * g + e * j, d * h + e * k, d * i + e * l + f),
    )


def _xy_affine(transform: Mapping[str, Any], input_axes: list[str] | None = None) -> _Affine | None:
    """The xy part of an NGFF coordinate transformation, or `None` if it can't be read."""
    kind = transform.get("type")
    axes = _axis_names(transform.get("input")) or input_axes
    if kind == "identity":
        return _IDENTITY
    if kind == "sequence":
        matrix = _IDENTITY
        for step in transform.get("transformations") or []:
            step_matrix = _xy_affine(step, axes)
            if step_matrix is None:
                return None
            matrix = _compose(step_matrix, matrix)
        return matrix
    if axes is None or "x" not in axes or "y" not in axes:
        return None
    x, y = axes.index("x"), axes.index("y")
    if kind == "scale":
        scale = transform.get("scale")
        if not isinstance(scale, list) or len(scale) != len(axes):
            return None
        return ((float(scale[x]), 0.0, 0.0), (0.0, float(scale[y]), 0.0))
    if kind == "translation":
        shift = transform.get("translation")
        if not isinstance(shift, list) or len(shift) != len(axes):
            return None
        return ((1.0, 0.0, float(shift[x])), (0.0, 1.0, float(shift[y])))
    if kind == "affine":
        rows = transform.get("affine")
        out_axes = _axis_names(transform.get("output"))
        if not isinstance(rows, list) or out_axes is None or "x" not in out_axes or "y" not in out_axes:
            return None
        row_x, row_y = rows[out_axes.index("x")], rows[out_axes.index("y")]
        return (
            (float(row_x[x]), float(row_x[y]), float(row_x[-1])),
            (float(row_y[x]), float(row_y[y]), float(row_y[-1])),
        )
    return None


def _element_attrs(element: Path) -> dict[str, Any] | None:
    if (element / "zarr.json").is_file():
        return read_json(element / "zarr.json").get("attributes") or {}
    if (element / ".zattrs").is_file():
        return read_json(element / ".zattrs")
    return None


def _element_transforms(attrs: Mapping[str, Any]) -> list[dict[str, Any]]:
    if isinstance(attrs.get("coordinateTransformations"), list):
        return attrs["coordinateTransformations"]  # points, shapes
    multiscales = (attrs.get("ome") or attrs).get("multiscales")  # images, labels
    if isinstance(multiscales, list) and multiscales:
        return multiscales[0].get("coordinateTransformations") or []
    return []


def _iter_elements(store_path: Path) -> Iterator[tuple[str, dict[str, Any]]]:
    for collection in _SPATIAL_COLLECTIONS:
        folder = store_path / collection
        if not folder.is_dir():
            continue
        for element in sorted(folder.iterdir()):
            attrs = _element_attrs(element) if element.is_dir() else None
            if attrs is not None:
                yield f"{collection}/{element.name}", attrs


def _transforms_by_coordinate_system(
    store_path: Path,
) -> dict[str, list[tuple[str, dict[str, Any]]]]:
    """Each coordinate system's (element path, transformation into it) pairs."""
    by_coordinate_system: dict[str, list[tuple[str, dict[str, Any]]]] = {}
    for path, attrs in _iter_elements(store_path):
        for transform in _element_transforms(attrs):
            output = transform.get("output") if isinstance(transform, dict) else None
            name = output.get("name") if isinstance(output, dict) else None
            if isinstance(name, str):
                by_coordinate_system.setdefault(name, []).append((path, transform))
    return by_coordinate_system


# --------------------------------------------------------------------------- root attrs


@dataclass
class _RootAttrs:
    """The store root's attributes, and every place a write has to put them."""

    store_path: Path
    attrs: dict[str, Any]
    zarr_format: int

    @classmethod
    def open(cls, store_path: Path) -> _RootAttrs:
        if not store_path.is_dir():
            raise WriterCommandError(f"Not a SpatialData Zarr directory: {store_path}")
        if (store_path / "zarr.json").is_file():
            attrs = read_json(store_path / "zarr.json").get("attributes") or {}
            return cls(store_path, dict(attrs), 3)
        if (store_path / ".zgroup").is_file():
            zattrs = store_path / ".zattrs"
            return cls(store_path, read_json(zattrs) if zattrs.is_file() else {}, 2)
        raise WriterCommandError(f"No zarr group metadata at {store_path}")

    def save(self) -> None:
        # v3 keeps the root's own attributes outside its consolidated listing.
        if self.zarr_format == 3:
            path = self.store_path / "zarr.json"
            doc = read_json(path)
            doc["attributes"] = self.attrs
            write_json(path, doc)
            return
        write_json(self.store_path / ".zattrs", self.attrs)
        zmetadata = self.store_path / ".zmetadata"
        if zmetadata.is_file():
            doc = read_json(zmetadata)
            doc.setdefault("metadata", {})[".zattrs"] = self.attrs
            write_json(zmetadata, doc)
