from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import pandas as pd
import pyarrow.parquet as pq

from .points import MORTON_CODE_2D_COLUMN

_UINT_INTERMEDIATE_SUFFIXES = ("_uint",)


def _dataframe_column(df: pd.DataFrame, name: str) -> pd.Series:
    column = df[name]
    if isinstance(column, pd.DataFrame):
        raise TypeError(f"expected column {name!r} to be a Series, got DataFrame")
    return column


def _series_extrema(series: pd.Series) -> tuple[float, float]:
    return float(series.min()), float(series.max())


@dataclass(frozen=True)
class VerifyCheck:
    id: str
    passed: bool
    detail: str


def _check(id: str, passed: bool, detail: str) -> VerifyCheck:
    return VerifyCheck(id=id, passed=passed, detail=detail)


def _count_sentinel_prefix(morton_values: pd.Series) -> int:
    count = 0
    for value in morton_values.head(4):
        if int(value) != 0:
            break
        count += 1
    return count


def verify_morton_parquet(path: str | Path) -> list[VerifyCheck]:
    parquet_path = Path(path)
    checks: list[VerifyCheck] = []

    if not parquet_path.is_file():
        return [_check("file_exists", False, f"Parquet file not found: {parquet_path}")]

    checks.append(_check("file_exists", True, str(parquet_path)))

    parquet = pq.ParquetFile(parquet_path)
    columns = parquet.schema_arrow.names
    checks.append(
        _check(
            "column_present",
            MORTON_CODE_2D_COLUMN in columns,
            f"expected column {MORTON_CODE_2D_COLUMN!r} in schema",
        )
    )

    uint_columns = [
        name
        for name in columns
        if any(name.endswith(suffix) for suffix in _UINT_INTERMEDIATE_SUFFIXES)
    ]
    checks.append(
        _check(
            "no_uint_intermediates",
            not uint_columns,
            "no uint staging columns"
            if not uint_columns
            else f"unexpected uint columns: {', '.join(uint_columns)}",
        )
    )

    if MORTON_CODE_2D_COLUMN not in columns:
        return checks

    df = pd.read_parquet(parquet_path, columns=[MORTON_CODE_2D_COLUMN, "x", "y"])
    morton_column = _dataframe_column(df, MORTON_CODE_2D_COLUMN)
    x_column = _dataframe_column(df, "x")
    y_column = _dataframe_column(df, "y")
    sentinel_count = _count_sentinel_prefix(morton_column)
    checks.append(
        _check(
            "sentinel_prefix",
            2 <= sentinel_count <= 4,
            f"sentinel prefix rows: {sentinel_count} (expected 2–4)",
        )
    )

    if sentinel_count > 0:
        sentinel_x = x_column.iloc[:sentinel_count]
        sentinel_y = y_column.iloc[:sentinel_count]
        sentinel_x_min, sentinel_x_max = _series_extrema(sentinel_x)
        dataset_x_min, dataset_x_max = _series_extrema(x_column)
        sentinel_y_min, sentinel_y_max = _series_extrema(sentinel_y)
        dataset_y_min, dataset_y_max = _series_extrema(y_column)
        bbox_match = (
            sentinel_x_min == dataset_x_min
            and sentinel_x_max == dataset_x_max
            and sentinel_y_min == dataset_y_min
            and sentinel_y_max == dataset_y_max
        )
        checks.append(
            _check(
                "sentinel_bbox",
                bbox_match,
                "sentinel rows encode full x/y bounds"
                if bbox_match
                else "sentinel x/y extrema do not match dataset bounds",
            )
        )

    if sentinel_count < len(df):
        tail = morton_column.iloc[sentinel_count:].astype("int64")
        monotonic = bool((tail.diff().dropna() >= 0).all())
        checks.append(
            _check(
                "morton_monotonic",
                monotonic,
                "morton_code_2d non-decreasing after sentinels"
                if monotonic
                else "morton_code_2d decreases after sentinel prefix",
            )
        )
    else:
        checks.append(
            _check(
                "morton_monotonic",
                True,
                "all rows are sentinel prefix (small dataset)",
            )
        )

    if parquet.num_row_groups > 0:
        first_group_rows = parquet.metadata.row_group(0).num_rows
        sentinel_only = first_group_rows <= 4 and first_group_rows == sentinel_count
        checks.append(
            _check(
                "row_group_sentinels",
                sentinel_only,
                f"row group 0 has {first_group_rows} rows (sentinel count {sentinel_count})",
            )
        )
    else:
        checks.append(_check("row_group_sentinels", False, "parquet has no row groups"))

    return checks


def verify_multiscale_parquet(path: str | Path) -> list[VerifyCheck]:
    parquet_path = Path(path)
    checks: list[VerifyCheck] = []

    if not parquet_path.is_file():
        return [_check("file_exists", False, f"Parquet file not found: {parquet_path}")]

    checks.append(_check("file_exists", True, str(parquet_path)))

    schema_metadata = pq.ParquetFile(parquet_path).schema_arrow.metadata
    if schema_metadata is None or b"spatialdata_multiscale" not in schema_metadata:
        checks.append(
            _check(
                "multiscale_metadata",
                False,
                "missing spatialdata_multiscale schema metadata",
            )
        )
        return checks

    stored = json.loads(schema_metadata[b"spatialdata_multiscale"])
    checks.append(
        _check(
            "multiscale_metadata",
            stored.get("format") == "spatialdata_multiscale_points",
            f"format={stored.get('format')!r}",
        )
    )

    bbox = stored.get("bounding_box")
    has_bbox = (
        isinstance(bbox, dict)
        and isinstance(bbox.get("min"), list)
        and isinstance(bbox.get("max"), list)
        and len(bbox.get("min", [])) > 0
        and len(bbox.get("max", [])) > 0
    )
    checks.append(
        _check(
            "multiscale_bbox",
            has_bbox,
            "bounding_box min/max present"
            if has_bbox
            else "bounding_box missing or incomplete",
        )
    )
    return checks


def verify_index_permutations_manifest(dest_zarr: str | Path) -> list[VerifyCheck]:
    dest_path = Path(dest_zarr)
    manifest_path = dest_path / "index-manifest.json"
    checks: list[VerifyCheck] = []

    if not manifest_path.is_file():
        return [
            _check(
                "manifest_exists",
                False,
                f"index-manifest.json not found under {dest_path}",
            )
        ]

    checks.append(_check("manifest_exists", True, str(manifest_path)))
    manifest: dict[str, Any] = json.loads(manifest_path.read_text())
    conditions = manifest.get("conditions", [])
    if not isinstance(conditions, list) or not conditions:
        checks.append(_check("manifest_conditions", False, "no conditions in manifest"))
        return checks

    checks.append(
        _check("manifest_conditions", True, f"{len(conditions)} condition(s) listed")
    )

    for condition in conditions:
        if not isinstance(condition, dict):
            continue
        condition_id = condition.get("id", "unknown")
        element_path = condition.get("element_path")
        if not isinstance(element_path, str):
            checks.append(
                _check(
                    f"path_{condition_id}",
                    False,
                    "condition missing element_path",
                )
            )
            continue

        parquet_path = dest_path / element_path / "points.parquet"
        if not parquet_path.is_file() and not parquet_path.is_dir():
            checks.append(
                _check(
                    f"path_{condition_id}",
                    False,
                    f"missing output: {parquet_path}",
                )
            )
            continue

        checks.append(_check(f"path_{condition_id}", True, str(parquet_path)))

        tiling_kind = condition.get("tiling_kind")
        if tiling_kind == "morton-points" and parquet_path.is_file():
            for morton_check in verify_morton_parquet(parquet_path):
                checks.append(
                    VerifyCheck(
                        id=f"{condition_id}_{morton_check.id}",
                        passed=morton_check.passed,
                        detail=morton_check.detail,
                    )
                )

    return checks


def all_passed(checks: list[VerifyCheck]) -> bool:
    return bool(checks) and all(check.passed for check in checks)
