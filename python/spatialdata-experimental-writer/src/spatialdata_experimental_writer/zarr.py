from __future__ import annotations

import json
from pathlib import Path
from typing import Any

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


def read_points_dataframe(parquet_path: str | Path) -> pd.DataFrame:
    path = Path(parquet_path)
    if not path.exists():
        raise FileNotFoundError(f"Points Parquet not found: {path}")
    if path.is_dir():
        table = ds.dataset(path, format="parquet").to_table()
    else:
        table = ds.dataset(path, format="parquet").to_table()
    return table.to_pandas()
