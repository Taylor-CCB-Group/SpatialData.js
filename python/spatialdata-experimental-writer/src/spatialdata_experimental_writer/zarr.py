from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Sequence

import pandas as pd
import pyarrow.dataset as ds


def _points_root(zarr_path: Path) -> Path:
    return zarr_path / "points"


def list_points_keys(zarr_path: str | Path) -> list[str]:
    root = _points_root(Path(zarr_path))
    if not root.is_dir():
        return []
    return sorted(
        child.name
        for child in root.iterdir()
        if child.is_dir() and (child / "zarr.json").is_file()
    )


def _read_zarr_json(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text())


def read_points_element_attrs(zarr_path: str | Path, points_key: str) -> dict[str, Any]:
    element_json = _points_root(Path(zarr_path)) / points_key / "zarr.json"
    if not element_json.is_file():
        raise FileNotFoundError(f"Points element not found: points/{points_key}")
    attrs = _read_zarr_json(element_json).get("attributes", {})
    spatialdata_attrs = attrs.get("spatialdata_attrs", {})
    if not isinstance(spatialdata_attrs, dict):
        spatialdata_attrs = {}
    return {
        "axes": attrs.get("axes", []),
        "feature_key": spatialdata_attrs.get("feature_key"),
        "instance_key": spatialdata_attrs.get("instance_key"),
        "version": spatialdata_attrs.get("version"),
    }


def points_parquet_path(zarr_path: str | Path, points_key: str) -> Path:
    return _points_root(Path(zarr_path)) / points_key / "points.parquet"


def experimental_points_output_path(zarr_path: str | Path, points_key: str) -> Path:
    return Path(zarr_path) / "points.experimental" / points_key / "points.parquet"


def _points_element_consolidated_entry(
    zarr_path: Path,
    points_key: str,
    *,
    metadata: dict[str, Any] | None = None,
) -> dict[str, Any]:
    if metadata is not None:
        entry = metadata.get(f"points/{points_key}")
        if isinstance(entry, dict):
            return json.loads(json.dumps(entry))
    element_json = _points_root(zarr_path) / points_key / "zarr.json"
    element_doc = _read_zarr_json(element_json)
    return {
        "attributes": element_doc.get("attributes", {}),
        "node_type": element_doc.get("node_type", "group"),
        "zarr_format": element_doc.get("zarr_format", 3),
    }


def read_store_consolidated_metadata(zarr_path: str | Path) -> dict[str, Any]:
    root_json = Path(zarr_path) / "zarr.json"
    if not root_json.is_file():
        raise FileNotFoundError(f"Missing store metadata: {root_json}")
    doc = _read_zarr_json(root_json)
    consolidated = doc.get("consolidated_metadata")
    if not isinstance(consolidated, dict):
        raise ValueError(f"Store has no consolidated metadata: {root_json}")
    metadata = consolidated.get("metadata")
    if not isinstance(metadata, dict):
        raise ValueError(f"Store consolidated metadata has no metadata map: {root_json}")
    return metadata


def register_points_elements_in_consolidated_metadata(
    zarr_path: str | Path,
    element_keys: Sequence[str],
    *,
    template_key: str,
) -> None:
    """Register sibling points elements in the store root consolidated metadata."""
    store_path = Path(zarr_path)
    root_json = store_path / "zarr.json"
    doc = _read_zarr_json(root_json)
    consolidated = doc.get("consolidated_metadata")
    if not isinstance(consolidated, dict):
        consolidated = {"kind": "inline", "metadata": {}}
        doc["consolidated_metadata"] = consolidated
    metadata = consolidated.get("metadata")
    if not isinstance(metadata, dict):
        metadata = {}
        consolidated["metadata"] = metadata

    template_entry = _points_element_consolidated_entry(
        store_path,
        template_key,
        metadata=metadata,
    )
    for key in element_keys:
        metadata[f"points/{key}"] = json.loads(json.dumps(template_entry))
    root_json.write_text(json.dumps(doc, indent=2) + "\n")


def read_points_dataframe(parquet_path: str | Path) -> pd.DataFrame:
    path = Path(parquet_path)
    if not path.exists():
        raise FileNotFoundError(f"Points Parquet not found: {path}")
    if path.is_dir():
        table = ds.dataset(path, format="parquet").to_table()
    else:
        table = ds.dataset(path, format="parquet").to_table()
    return table.to_pandas()
