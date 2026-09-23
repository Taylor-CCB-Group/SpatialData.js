from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Literal, Sequence

import numpy as np
import pandas as pd
import pyarrow as pa
import pyarrow.compute as pc
import pyarrow.parquet as pq

MORTON_CODE_2D_COLUMN = "morton_code_2d"
MORTON_CODE_EXTREME_VALUE_INDICATOR = np.uint32(0)
MORTON_CODE_BITS_PER_AXIS = 16
MORTON_CODE_VALUE_MAX = np.uint32((2**MORTON_CODE_BITS_PER_AXIS) - 1)
MORTON_SENTINEL_COUNT_ATTR = "spatialdata_experimental_morton_sentinel_count"
#: `DataFrame.attrs` key carrying the resolved {@link ColumnEncodingPlan} back to
#: the caller, so a benchmark manifest can record what was actually written.
ENCODING_PLAN_ATTR = "spatialdata_js_util_encoding_plan"

#: Bits of Morton key consumed per level of spatial subdivision. Two for the
#: 2-D key here (a quadtree); a 3-D key would be three (an octree), which is why
#: coarsening shifts by this rather than by a literal.
MORTON_BITS_PER_LEVEL = 2

#: Transient sort key for coarsened-Morton conditions. Dropped before writing —
#: it is recoverable from `morton_code_2d >> (MORTON_BITS_PER_LEVEL * levels)`,
#: so storing it would
#: put a redundant column on the wire of every tile read.
MORTON_COARSE_COLUMN = "__morton_coarse__"

#: A column keeps dictionary encoding only while its distinct values stay below
#: this fraction of its length. Above it, RLE_DICTIONARY stores a dictionary
#: nearly as large as the data plus an index per row, and loses to the plain or
#: delta encodings — measurably so on transcript coordinates, where the default
#: made `x`, `y`, `z` and `morton_code_2d` *larger* compressed than raw.
DICTIONARY_CARDINALITY_RATIO = 0.125

EncodingPolicy = Literal["auto", "pyarrow-default"]
ENCODING_POLICIES: frozenset[str] = frozenset(("auto", "pyarrow-default"))


@dataclass(frozen=True)
class ColumnEncodingPlan:
    """Per-column encoding choices, resolved against the data being written."""

    #: Columns that keep dictionary encoding. Passed to pyarrow as
    #: `use_dictionary=[...]`, which means *only* these.
    use_dictionary: list[str] = field(default_factory=list)
    #: Explicit encoding for the columns that drop the dictionary.
    column_encoding: dict[str, str] = field(default_factory=dict)

    def as_manifest(self) -> dict[str, Any]:
        return {
            "use_dictionary": sorted(self.use_dictionary),
            "column_encoding": dict(sorted(self.column_encoding.items())),
        }


def _is_non_decreasing(column: pa.ChunkedArray | pa.Array) -> bool:
    if column.null_count:
        return False
    values = np.asarray(column.to_numpy(zero_copy_only=False))
    if values.size < 2:
        return True
    return bool(np.all(values[1:] >= values[:-1]))


def plan_column_encodings(table: pa.Table) -> ColumnEncodingPlan:
    """Choose an encoding per column from the data, not from column names.

    Dictionary encoding is the pyarrow default for every column, and it is the
    right one only for genuinely low-cardinality data. The policy here:

    * **float** — `BYTE_STREAM_SPLIT`, which groups the mantissa bytes so zstd
      has something to find in coordinates that share an exponent.
    * **integer, low cardinality** — keep the dictionary (`feature_name_codes`,
      `overlaps_nucleus`, and any other small code space).
    * **integer, high cardinality, non-decreasing** — `DELTA_BINARY_PACKED`;
      this is the Morton column and the row index, where successive values
      differ by very little.
    * **integer, high cardinality, unordered** — `PLAIN`. Deltas of random
      identifiers are no smaller than the identifiers (`transcript_id`).
    * **everything else** — unchanged. Strings and categoricals are what the
      dictionary is for.
    """
    plan_use_dictionary: list[str] = []
    plan_column_encoding: dict[str, str] = {}

    for name, column_type in zip(table.column_names, table.schema.types):
        column = table.column(name)
        if pa.types.is_floating(column_type):
            plan_column_encoding[name] = "BYTE_STREAM_SPLIT"
            continue
        if pa.types.is_integer(column_type):
            distinct = pc.count_distinct(column).as_py() or 0
            if distinct <= max(1, int(table.num_rows * DICTIONARY_CARDINALITY_RATIO)):
                plan_use_dictionary.append(name)
                continue
            plan_column_encoding[name] = (
                "DELTA_BINARY_PACKED" if _is_non_decreasing(column) else "PLAIN"
            )
            continue
        plan_use_dictionary.append(name)

    return ColumnEncodingPlan(
        use_dictionary=plan_use_dictionary,
        column_encoding=plan_column_encoding,
    )


def _declarable_sorting_columns(
    table: pa.Table, sort_columns: Sequence[str] | None
) -> list[pq.SortingColumn]:
    """Declare the leading sort key in the footer — but only if the file honours it.

    `morton_sort_points` prepends sentinel rows before the sorted body, so a
    file's declared order and its actual order can disagree: on a Morton-primary
    artifact the sentinels carry code 0 and the column still ascends, while on a
    feature-primary one they carry their own feature codes and it does not.
    A reader that trusts a wrong declaration bisects into nonsense, which is the
    failure `docs/plans/points-morton-tiled-viewport-loading.md` records, so this
    verifies before it declares and stays silent when it cannot.
    """
    if not sort_columns:
        return []
    leading = sort_columns[0]
    if leading not in table.column_names:
        return []
    if not _is_non_decreasing(table.column(leading)):
        return []
    return [pq.SortingColumn(table.column_names.index(leading), descending=False)]


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


def _extreme_positions(df: pd.DataFrame) -> list[int]:
    extreme_values = [
        ("x", df["x"].min()),
        ("x", df["x"].max()),
        ("y", df["y"].min()),
        ("y", df["y"].max()),
    ]
    result: list[int] = []
    for column, value in extreme_values:
        matches = np.flatnonzero((df[column] == value).to_numpy())
        if len(matches) == 0:
            continue
        position = int(matches[0])
        if position not in result:
            result.append(position)
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


def morton_sort_points(
    df: pd.DataFrame,
    *,
    feature_key: str | None = None,
    sort_order: Sequence[str] | None = None,
    morton_coarsen_levels: int | None = None,
) -> pd.DataFrame:
    """Morton-index the points and sort them, sentinel bounding-box rows first.

    `morton_coarsen_levels` adds the transient {@link MORTON_COARSE_COLUMN} key,
    `morton_code_2d >> (MORTON_BITS_PER_LEVEL * levels)` — one level of spatial
    subdivision per unit. A `sort_order`
    of `(MORTON_COARSE_COLUMN, feature_codes, MORTON_CODE_2D_COLUMN)` then makes
    same-feature rows contiguous *within* a spatial bucket, which is the shape a
    feature selection needs in order to skip row groups. The column is dropped
    before the frame is returned.
    """
    missing = [column for column in ("x", "y") if column not in df.columns]
    if missing:
        raise ValueError("Points dataframe is missing required columns: " + ", ".join(missing))
    if morton_coarsen_levels is not None and not 0 < morton_coarsen_levels < MORTON_CODE_BITS_PER_AXIS:
        raise ValueError(
            "morton_coarsen_levels must be between 1 and "
            f"{MORTON_CODE_BITS_PER_AXIS - 1}, got {morton_coarsen_levels}"
        )

    out = _append_feature_codes(df.copy(), feature_key)
    x_min = float(out["x"].min())
    x_max = float(out["x"].max())
    y_min = float(out["y"].min())
    y_max = float(out["y"].max())
    x_uint = _norm_series_to_uint(out["x"], x_min, x_max)
    y_uint = _norm_series_to_uint(out["y"], y_min, y_max)
    out[MORTON_CODE_2D_COLUMN] = morton_code_2d(x_uint, y_uint)
    if morton_coarsen_levels is not None:
        out[MORTON_COARSE_COLUMN] = np.right_shift(
            out[MORTON_CODE_2D_COLUMN].to_numpy(np.uint32),
            MORTON_BITS_PER_LEVEL * morton_coarsen_levels,
        )

    sentinel_positions = _extreme_positions(out)
    sentinel = out.iloc[sentinel_positions].copy().reset_index(drop=True)
    sentinel[MORTON_CODE_2D_COLUMN] = MORTON_CODE_EXTREME_VALUE_INDICATOR

    rest_mask = np.ones(len(out), dtype=bool)
    rest_mask[sentinel_positions] = False
    rest = out.iloc[rest_mask]
    if sort_order is None:
        sort_columns: list[str] = [MORTON_CODE_2D_COLUMN]
        if "z" in rest.columns and rest["z"].nunique(dropna=False) < 100:
            sort_columns = ["z", MORTON_CODE_2D_COLUMN]
    else:
        sort_columns = list(sort_order)
    rest = rest.sort_values(sort_columns, kind="mergesort").reset_index(drop=True)

    combined = pd.concat([sentinel, rest], ignore_index=True)
    if MORTON_COARSE_COLUMN in combined.columns:
        combined = combined.drop(columns=[MORTON_COARSE_COLUMN])
    combined = _move_string_like_columns_right(combined)
    combined.attrs[MORTON_SENTINEL_COUNT_ATTR] = len(sentinel)
    return combined


def _write_arrow_table_in_row_groups(
    table: pa.Table,
    output_path: Path,
    *,
    row_group_size: int,
    sentinel_count: int | None = None,
    metadata: dict[str, Any] | None = None,
    compression: str = "zstd",
    encodings: EncodingPolicy = "auto",
    write_page_index: bool = True,
    sort_columns: Sequence[str] | None = None,
) -> ColumnEncodingPlan | None:
    if row_group_size <= 0:
        raise ValueError("row_group_size must be positive")
    # `EncodingPolicy` is a type hint, which a CLI or TUI string sails straight past. An
    # unrecognised value silently wrote pyarrow defaults and reported them as the tuned
    # plan, so a typo was indistinguishable from the real thing in the manifest.
    if encodings not in ENCODING_POLICIES:
        raise ValueError(
            f"Unknown encoding policy {encodings!r}; expected one of "
            + ", ".join(sorted(ENCODING_POLICIES))
        )
    output_path.parent.mkdir(parents=True, exist_ok=True)
    schema = table.schema
    if metadata:
        merged = dict(schema.metadata or {})
        merged[b"spatialdata_multiscale"] = json.dumps(metadata).encode()
        schema = schema.with_metadata(merged)

    # `None`, not an empty plan: an empty `ColumnEncodingPlan` serialises to
    # `{"use_dictionary": [], "column_encoding": {}}`, which a manifest reader would take
    # to mean "no column uses a dictionary" — the exact opposite of what pyarrow's
    # default does. Absent is the honest record for "we did not choose".
    plan = plan_column_encodings(table) if encodings == "auto" else None
    encoding_options: dict[str, Any] = (
        {
            "use_dictionary": plan.use_dictionary,
            "column_encoding": plan.column_encoding,
        }
        if plan is not None
        else {}
    )
    sorting_columns = _declarable_sorting_columns(table, sort_columns)

    writer = pq.ParquetWriter(
        output_path,
        schema,
        compression=compression,
        write_statistics=True,
        write_page_index=write_page_index,
        **({"sorting_columns": sorting_columns} if sorting_columns else {}),
        **encoding_options,
    )
    try:
        if sentinel_count is None:
            sentinel_count = 0
        if sentinel_count == 0 and MORTON_CODE_2D_COLUMN in table.column_names:
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
    return plan


def write_morton_points_parquet(
    df: pd.DataFrame,
    output_path: str | Path,
    *,
    feature_key: str | None = None,
    sort_order: Sequence[str] | None = None,
    row_group_size: int = 50_000,
    compression: str = "zstd",
    encodings: EncodingPolicy = "auto",
    write_page_index: bool = True,
    morton_coarsen_levels: int | None = None,
) -> pd.DataFrame:
    sorted_df = morton_sort_points(
        df,
        feature_key=feature_key,
        sort_order=sort_order,
        morton_coarsen_levels=morton_coarsen_levels,
    )
    indexed = sorted_df.copy()
    indexed.index.name = "__index_level_0__"
    table = pa.Table.from_pandas(indexed, preserve_index=True)
    sentinel_count = sorted_df.attrs.get(MORTON_SENTINEL_COUNT_ATTR)
    if not isinstance(sentinel_count, int):
        sentinel_count = None
    plan = _write_arrow_table_in_row_groups(
        table,
        Path(output_path),
        row_group_size=row_group_size,
        sentinel_count=sentinel_count,
        compression=compression,
        encodings=encodings,
        write_page_index=write_page_index,
        # A coarsened condition's leading key is dropped before the write, so no
        # column in the file describes the order — `_declarable_sorting_columns`
        # finds nothing and declares nothing, which is the honest answer.
        sort_columns=sort_order or [MORTON_CODE_2D_COLUMN],
    )
    sorted_df.attrs[ENCODING_PLAN_ATTR] = plan
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
    encodings: EncodingPolicy = "auto",
    write_page_index: bool = True,
) -> None:
    table = pa.Table.from_pandas(df, preserve_index=False)
    sort_keys: list[tuple[str, str]] = []
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
        encodings=encodings,
        write_page_index=write_page_index,
        sort_columns=[name for name, _ in sort_keys],
    )
