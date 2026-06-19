from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd
import pyarrow as pa
import pyarrow.compute as pc
import pyarrow.parquet as pq

MORTON_CODE_2D_COLUMN = "morton_code_2d"
MORTON_CODE_EXTREME_VALUE_INDICATOR = np.uint32(0)
MORTON_CODE_BITS_PER_AXIS = 16
MORTON_CODE_VALUE_MAX = np.uint32((2**MORTON_CODE_BITS_PER_AXIS) - 1)


def _norm_series_to_uint(series: pd.Series, v_min: float, v_max: float) -> pd.Series:
    if v_max == v_min:
        return pd.Series(np.zeros(len(series), dtype=np.uint32), index=series.index)
    normalized = (series.astype("float64") - v_min) / (v_max - v_min)
    clipped = normalized.clip(0.0, 1.0).fillna(0.0)
    return (clipped * int(MORTON_CODE_VALUE_MAX)).astype(np.uint32)


def _part1by1_16(values: np.ndarray) -> np.ndarray:
    x = values.astype(np.uint32) & np.uint32(0x0000FFFF)
    x = (x | np.left_shift(x, 8)) & np.uint32(0x00FF00FF)
    x = (x | np.left_shift(x, 4)) & np.uint32(0x0F0F0F0F)
    x = (x | np.left_shift(x, 2)) & np.uint32(0x33333333)
    x = (x | np.left_shift(x, 1)) & np.uint32(0x55555555)
    return x


def morton_code_2d(x_uint: pd.Series, y_uint: pd.Series) -> np.ndarray:
    xs = _part1by1_16(x_uint.to_numpy(np.uint32))
    ys = _part1by1_16(y_uint.to_numpy(np.uint32))
    return (np.left_shift(ys.astype(np.uint64), 1) | xs.astype(np.uint64)).astype(np.uint32)


def _extreme_indices(df: pd.DataFrame) -> list[Any]:
    extreme_values = [
        ("x", df["x"].min()),
        ("x", df["x"].max()),
        ("y", df["y"].min()),
        ("y", df["y"].max()),
    ]
    result: list[Any] = []
    for column, value in extreme_values:
        matches = df.index[df[column] == value]
        if len(matches) == 0:
            continue
        index = matches[0]
        if index not in result:
            result.append(index)
    return result


def _append_feature_codes(df: pd.DataFrame, feature_key: str | None) -> pd.DataFrame:
    if not feature_key or feature_key not in df.columns:
        return df
    code_column = f"{feature_key}_codes"
    if code_column in df.columns:
        return df
    out = df.copy()
    values = out[feature_key]
    if isinstance(values.dtype, pd.CategoricalDtype):
        out[code_column] = values.cat.codes.astype("int32")
    else:
        categories = pd.Categorical(values)
        out[code_column] = categories.codes.astype("int32")
    return out


def _move_string_like_columns_right(df: pd.DataFrame) -> pd.DataFrame:
    string_like: list[str] = []
    other: list[str] = []
    for column in df.columns:
        dtype = df[column].dtype
        if isinstance(dtype, pd.CategoricalDtype) or pd.api.types.is_string_dtype(dtype):
            string_like.append(column)
        else:
            other.append(column)
    return df[[*other, *string_like]]


def morton_sort_points(df: pd.DataFrame, *, feature_key: str | None = None) -> pd.DataFrame:
    missing = [column for column in ("x", "y") if column not in df.columns]
    if missing:
        raise ValueError("Points dataframe is missing required columns: " + ", ".join(missing))

    out = _append_feature_codes(df.copy(), feature_key)
    x_min = float(out["x"].min())
    x_max = float(out["x"].max())
    y_min = float(out["y"].min())
    y_max = float(out["y"].max())
    out["x_uint"] = _norm_series_to_uint(out["x"], x_min, x_max)
    out["y_uint"] = _norm_series_to_uint(out["y"], y_min, y_max)
    out[MORTON_CODE_2D_COLUMN] = morton_code_2d(out["x_uint"], out["y_uint"])

    sentinel_indices = _extreme_indices(out)
    sentinel = out.loc[sentinel_indices].copy().reset_index(drop=True)
    sentinel[MORTON_CODE_2D_COLUMN] = MORTON_CODE_EXTREME_VALUE_INDICATOR

    rest = out.drop(index=sentinel_indices)
    sort_columns = [MORTON_CODE_2D_COLUMN]
    if "z" in rest.columns and rest["z"].nunique(dropna=False) < 100:
        sort_columns = ["z", MORTON_CODE_2D_COLUMN]
    rest = rest.sort_values(sort_columns, kind="mergesort").reset_index(drop=True)

    combined = pd.concat([sentinel, rest], ignore_index=True)
    return _move_string_like_columns_right(combined)


def _write_arrow_table_in_row_groups(
    table: pa.Table,
    output_path: Path,
    *,
    row_group_size: int,
    metadata: dict[str, Any] | None = None,
    compression: str = "zstd",
) -> None:
    if row_group_size <= 0:
        raise ValueError("row_group_size must be positive")
    output_path.parent.mkdir(parents=True, exist_ok=True)
    schema = table.schema
    if metadata:
        merged = dict(schema.metadata or {})
        merged[b"spatialdata_multiscale"] = json.dumps(metadata).encode()
        schema = schema.with_metadata(merged)

    writer = pq.ParquetWriter(output_path, schema, compression=compression, write_statistics=True)
    try:
        sentinel_count = 0
        if MORTON_CODE_2D_COLUMN in table.column_names:
            morton_column = table.column(MORTON_CODE_2D_COLUMN).combine_chunks()
            for i in range(min(4, table.num_rows)):
                if morton_column[i].as_py() != 0:
                    break
                sentinel_count += 1
        if sentinel_count:
            writer.write_table(table.slice(0, sentinel_count), row_group_size=sentinel_count)
        for start in range(sentinel_count, table.num_rows, row_group_size):
            chunk = table.slice(start, min(row_group_size, table.num_rows - start))
            writer.write_table(chunk, row_group_size=chunk.num_rows)
    finally:
        writer.close()


def write_morton_points_parquet(
    df: pd.DataFrame,
    output_path: str | Path,
    *,
    feature_key: str | None = None,
    row_group_size: int = 50_000,
    compression: str = "zstd",
) -> pd.DataFrame:
    sorted_df = morton_sort_points(df, feature_key=feature_key)
    table = pa.Table.from_pandas(sorted_df, preserve_index=False)
    _write_arrow_table_in_row_groups(
        table,
        Path(output_path),
        row_group_size=row_group_size,
        compression=compression,
    )
    return sorted_df


def build_spatialdata_multiscale_metadata(
    df: pd.DataFrame,
    *,
    axes: tuple[str, ...] = ("x", "y", "z"),
    coordinate_space: str = "raw",
    version: str = "1.0",
    levels: list[dict[str, Any]] | None = None,
    limit: int | None = None,
) -> dict[str, Any]:
    available_axes = [axis for axis in axes if axis in df.columns]
    if not available_axes:
        raise ValueError("No requested coordinate axes are present in the dataframe.")
    return {
        "version": version,
        "format": "spatialdata_multiscale_points",
        "axes": available_axes,
        "bounding_box": {
            "min": [float(df[axis].min()) for axis in available_axes],
            "max": [float(df[axis].max()) for axis in available_axes],
        },
        "coordinate_space": coordinate_space,
        "limit": limit,
        "levels": levels or [],
        "n_points_total": int(len(df)),
    }


def write_multiscale_points_parquet(
    df: pd.DataFrame,
    output_path: str | Path,
    *,
    metadata: dict[str, Any],
    row_group_size: int = 50_000,
    compression: str = "zstd",
) -> None:
    table = pa.Table.from_pandas(df, preserve_index=False)
    if {"__spatial_index__", "__morton__"}.issubset(df.columns):
        sort_keys = [("__spatial_index__", "ascending"), ("__morton__", "ascending")]
        if "gene" in df.columns:
            sort_keys.insert(0, ("gene", "ascending"))
        table = table.take(pc.sort_indices(table, sort_keys=sort_keys))
    _write_arrow_table_in_row_groups(
        table,
        Path(output_path),
        row_group_size=row_group_size,
        metadata=metadata,
        compression=compression,
    )
