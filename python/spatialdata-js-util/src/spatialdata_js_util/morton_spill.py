"""Morton-sort points Parquet larger than memory, writing the in-memory path's file.

`write_morton_points_parquet` holds the whole table, several times over, while it
sorts. This writes the same file from a bounded working set by streaming the input
three times and spilling to disk:

1. **Survey**: row count, x/y bounds and the rows holding them (the sentinels),
   the distinct `z` values, and the categories of every dictionary column.
2. **Histogram** of the sort key's leading bits (`z` rank, then a Morton prefix),
   from which contiguous key ranges are grouped into buckets that fit the budget.
3. **Spill**: each row goes, in input order, to its bucket's Arrow IPC file, with
   dictionary columns re-coded against the survey's categories so every bucket
   decodes to the same pandas categories.

Each bucket is then a key range that sorts independently, and since rows reach it
in input order a stable sort within it gives the global stable sort's rows. The
buckets go through the same pandas steps as the in-memory path, and the row groups
are cut at the same rows.
"""

from __future__ import annotations

import itertools
import json
import math
import tempfile
from collections.abc import Callable, Iterator
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd
import pyarrow as pa
import pyarrow.compute as pc
import pyarrow.dataset as ds
import pyarrow.ipc as ipc
import pyarrow.parquet as pq

from .points import (
    DICTIONARY_CARDINALITY_RATIO,
    MORTON_CODE_2D_COLUMN,
    MORTON_CODE_EXTREME_VALUE_INDICATOR,
    MORTON_SENTINEL_COUNT_ATTR,
    ColumnEncodingPlan,
    EncodingPolicy,
    _move_string_like_columns_right,
    _norm_series_to_uint,
    morton_code_2d,
    write_morton_points_parquet,
)
from .store import DEFAULT_MEMORY_BUDGET, remove_tree
#: Bytes a row costs while a bucket is sorted, per byte of its Arrow width: the
#: pandas frame, its sorted copy, the concatenation, and the Arrow table written.
_WORKING_COPIES = 8
#: The in-memory path keeps more copies alive at once (read, copy, sort, concat,
#: copy, Arrow), measured at roughly this multiple of the Arrow width.
_IN_MEMORY_COPIES = 12
#: `morton_sort_points` sorts by z first only while z has fewer distinct values.
_Z_SORT_LIMIT = 100
_ROW_COLUMN = "__morton_spill_row__"
#: The scanner's defaults (16 batches x 4 files) queue gigabytes of decoded batches
#: whenever the consumer is slower than the read, which the spill always is.
_READAHEAD = {"batch_readahead": 1, "fragment_readahead": 1}
#: `write_morton_points_parquet` writes the frame's index as this column.
_WRITTEN_INDEX = "__index_level_0__"

Progress = Callable[[str], None]


def _row_width(schema: pa.Schema) -> int:
    width = 0
    for column_type in schema.types:
        if pa.types.is_dictionary(column_type):
            width += 4
        elif pa.types.is_boolean(column_type):
            width += 1
        else:
            try:
                width += max(1, column_type.bit_width // 8)
            except ValueError:
                width += 32  # variable width: a guess for short strings
    return width + 8  # the Morton and code columns added on the way


def estimate_in_memory_bytes(source: str | Path) -> int:
    """Rough peak memory of `write_morton_points_parquet` on *source*."""
    dataset = ds.dataset(source, format="parquet")
    by_width = dataset.count_rows() * _row_width(dataset.schema)
    # Parquet's uncompressed sizes catch wide string columns the width guess misses.
    uncompressed = 0
    for fragment in dataset.get_fragments():
        metadata = fragment.metadata
        uncompressed += sum(
            metadata.row_group(i).total_byte_size for i in range(metadata.num_row_groups)
        )
    return max(by_width, uncompressed) * _IN_MEMORY_COPIES


class _DistinctCounter:
    """Distinct count of an integer column, abandoned once it passes *limit*.

    Values of 32 bits or fewer set bits in a bitmap (at most 512 MB), which is
    exact at any count. Wider values are kept as a sorted unique array, which on
    a billion-row Morton column reached ~10 GB before passing the limit; that
    array is capped at *max_values*, past which the column counts as exceeding
    *limit* even when it might not, costing only a less compact encoding.
    """

    def __init__(self, limit: int, *, max_values: int, max_bitmap_bytes: int):
        self.limit = limit
        self.max_bitmap_bytes = max_bitmap_bytes
        self.max_values = max_values
        self.exceeded = False
        self._dtype: np.dtype | None = None
        self._bitmap: np.ndarray | None = None
        self._unique: np.ndarray | None = None
        self._pending: list[np.ndarray] = []
        self._pending_size = 0

    def add(self, values: np.ndarray) -> None:
        if self.exceeded or values.size == 0:
            return
        # The sentinels arrive through pandas, which can widen the type.
        self._dtype = self._dtype or values.dtype
        values = values.astype(self._dtype, copy=False)
        if self._bitmap is not None or (
            values.dtype.itemsize <= 4 and 1 << (values.dtype.itemsize * 8 - 3) <= self.max_bitmap_bytes
        ):
            self._set_bits(values)
            return
        self._pending.append(np.unique(values))
        self._pending_size += self._pending[-1].size
        # Merge once pending matches the kept set, or a quarter of the cap; pending
        # plus the merge copy then stays within a small multiple of max_values.
        floor = max(1, min(1 << 22, self.max_values // 4))
        if self._pending_size > max(0 if self._unique is None else self._unique.size, floor):
            self._merge()

    def _set_bits(self, values: np.ndarray) -> None:
        width = values.dtype.itemsize * 8
        if self._bitmap is None:
            self._bitmap = np.zeros(1 << max(0, width - 3), dtype=np.uint8)
        # Reinterpret signed values as unsigned: a bijection, so counts are unchanged.
        unsigned = np.unique(values.view(f"u{values.dtype.itemsize}")).astype(np.uint64)
        byte = unsigned >> np.uint64(3)
        bit = np.left_shift(np.uint8(1), (unsigned & np.uint64(7)).astype(np.uint8))
        starts = np.flatnonzero(np.r_[True, byte[1:] != byte[:-1]])
        self._bitmap[byte[starts]] |= np.bitwise_or.reduceat(bit, starts)

    def _merge(self) -> None:
        if not self._pending:
            return
        parts = self._pending if self._unique is None else [self._unique, *self._pending]
        self._unique = np.unique(np.concatenate(parts))
        self._pending = []
        self._pending_size = 0
        if self._unique.size > min(self.limit, self.max_values):
            self.exceeded = True
            self._unique = None

    def count(self) -> int | None:
        """The count, or None once it is known (or assumed) to exceed the limit."""
        if self._bitmap is not None:
            count = int(np.unpackbits(self._bitmap).sum()) if self._bitmap.size <= 1 << 16 else sum(
                int(np.unpackbits(self._bitmap[i : i + (1 << 24)]).sum())
                for i in range(0, self._bitmap.size, 1 << 24)
            )
            return None if count > self.limit else count
        self._merge()
        if self.exceeded:
            return None
        return 0 if self._unique is None else int(self._unique.size)


@dataclass
class _Survey:
    rows: int = 0
    bounds: dict[str, list[float]] = field(default_factory=dict)
    #: (value, first row) per extreme, in `_extreme_positions` order.
    extremes: list[tuple[float, int]] = field(default_factory=list)
    extreme_z: dict[int, Any] = field(default_factory=dict)
    z_counts: dict[Any, int] | None = None
    z_dtype: Any = np.float64
    categories: dict[str, list[Any]] = field(default_factory=dict)

    def sentinel_rows(self) -> list[int]:
        result: list[int] = []
        for _, row in self.extremes:
            if row >= 0 and row not in result:
                result.append(row)
        return result


def _z_key(value: Any) -> Any:
    return "nan" if isinstance(value, float) and math.isnan(value) else value


def _survey(dataset: ds.Dataset, feature_key: str | None, has_z: bool) -> _Survey:
    schema = dataset.schema
    dictionary_columns = [n for n, t in zip(schema.names, schema.types) if pa.types.is_dictionary(t)]
    string_feature = (
        feature_key is not None
        and feature_key in schema.names
        and feature_key not in dictionary_columns
        and f"{feature_key}_codes" not in schema.names
    )
    columns = ["x", "y", *(["z"] if has_z else []), *dictionary_columns]
    if string_feature:
        columns.append(feature_key)
    survey = _Survey(z_counts={} if has_z else None)
    if has_z:
        survey.z_dtype = np.dtype(schema.field("z").type.to_pandas_dtype())
    # (min x, max x, min y, max y): best value and its first row.
    best = [(math.inf, -1), (-math.inf, -1), (math.inf, -1), (-math.inf, -1)]
    seen: dict[str, dict[Any, None]] = {name: {} for name in dictionary_columns}
    feature_uniques: list[np.ndarray] = []

    # The default batch size, as `to_table` uses: a chunk's dictionary can depend on it.
    for batch in dataset.to_batches(columns=columns, **_READAHEAD):
        offset = survey.rows
        survey.rows += batch.num_rows
        for slot, (axis, is_min) in enumerate((("x", True), ("x", False), ("y", True), ("y", False))):
            values = batch.column(axis).to_numpy(zero_copy_only=False)
            if values.size == 0 or np.all(np.isnan(values)):
                continue
            candidate = np.nanmin(values) if is_min else np.nanmax(values)
            better = candidate < best[slot][0] if is_min else candidate > best[slot][0]
            if better:
                row = offset + int(np.flatnonzero(values == candidate)[0])
                best[slot] = (candidate, row)
                if has_z:
                    survey.extreme_z[row] = batch.column("z")[row - offset].as_py()
        if has_z and survey.z_counts is not None:
            z = batch.column("z").to_numpy(zero_copy_only=False)
            unique, counts = np.unique(z, return_counts=True)
            for value, count in zip(unique.tolist(), counts.tolist()):
                key = _z_key(value)
                survey.z_counts[key] = survey.z_counts.get(key, 0) + count
            # Past this many, the rest cannot drop below the limit once sentinels go.
            if len(survey.z_counts) > _Z_SORT_LIMIT + 4:
                survey.z_counts = None
        for name in dictionary_columns:
            # pyarrow unifies chunk dictionaries in first-appearance order, which
            # fixes the pandas categories, and so the codes, of the in-memory path.
            for value in batch.column(name).dictionary.to_pylist():
                seen[name].setdefault(value, None)
        if string_feature:
            values = batch.column(feature_key).drop_null()
            feature_uniques.append(pc.unique(values).to_numpy(zero_copy_only=False))
            if len(feature_uniques) >= 64:
                feature_uniques = [pd.unique(np.concatenate(feature_uniques))]

    survey.extremes = [(float(value), row) for value, row in best]
    survey.categories = {name: list(values) for name, values in seen.items()}
    if string_feature and feature_key is not None:
        merged = pd.unique(np.concatenate(feature_uniques)) if feature_uniques else []
        survey.categories[feature_key] = list(pd.Categorical(merged).categories)
    for name, values in zip(("x", "y"), ((0, 1), (2, 3))):
        survey.bounds[name] = [best[values[0]][0], best[values[1]][0]]
    return survey


def _z_sort_order(survey: _Survey) -> list[Any] | None:
    """The rest's z values in sort order (NaN last), or None to sort by Morton alone."""
    if survey.z_counts is None:
        return None
    counts = dict(survey.z_counts)
    for row in survey.sentinel_rows():
        key = _z_key(survey.extreme_z.get(row))
        counts[key] -= 1
        if counts[key] == 0:
            del counts[key]
    if len(counts) >= _Z_SORT_LIMIT:
        return None
    numbers = sorted(key for key in counts if key != "nan")
    return [*numbers, "nan"] if "nan" in counts else numbers


def _morton(frame: pd.DataFrame, survey: _Survey) -> np.ndarray:
    (x_min, x_max), (y_min, y_max) = survey.bounds["x"], survey.bounds["y"]
    x_uint = _norm_series_to_uint(frame["x"], float(x_min), float(x_max))
    y_uint = _norm_series_to_uint(frame["y"], float(y_min), float(y_max))
    return morton_code_2d(x_uint, y_uint)


class _Keyer:
    """Maps rows to a bin of the leading sort key: z rank, then a Morton prefix."""

    def __init__(self, survey: _Survey, z_order: list[Any] | None):
        self.survey = survey
        self.z_values = None
        if z_order is not None:
            numbers = [value for value in z_order if value != "nan"]
            # The column's own dtype: float64 would merge int64 values above 2**53.
            self.z_values = np.asarray(numbers, dtype=survey.z_dtype)
            self.z_has_nan = len(numbers) < len(z_order)
        z_ranks = 1 if z_order is None else max(1, len(z_order))
        self.prefix_bits = 20 if z_order is None else 14
        self.bins = z_ranks << self.prefix_bits

    def __call__(self, batch: pa.RecordBatch, morton: np.ndarray) -> np.ndarray:
        prefix = (morton >> np.uint32(32 - self.prefix_bits)).astype(np.int64)
        if self.z_values is None:
            return prefix
        z = batch.column("z").to_numpy(zero_copy_only=False)
        rank = np.searchsorted(self.z_values, z)
        if z.dtype.kind == "f":
            rank[np.isnan(z)] = len(self.z_values)
        return (rank.astype(np.int64) << self.prefix_bits) | prefix


def _rest_mask(offset: int, length: int, sentinels: list[int]) -> np.ndarray:
    mask = np.ones(length, dtype=bool)
    for row in sentinels:
        if offset <= row < offset + length:
            mask[row - offset] = False
    return mask


def _bucket_edges(histogram: np.ndarray, bucket_rows: int) -> np.ndarray:
    """Bin indices where each bucket starts, grouping contiguous bins up to *bucket_rows*."""
    starts = [0]
    running = 0
    for index in np.flatnonzero(histogram):
        count = int(histogram[index])
        if running and running + count > bucket_rows:
            starts.append(int(index))
            running = 0
        running += count
    return np.asarray(starts, dtype=np.int64)


def _recode(column: pa.Array, categories: pa.Array) -> pa.Array:
    """Indices of *column*'s values in *categories*, as int32."""
    if pa.types.is_dictionary(column.type):
        lookup = pc.index_in(column.dictionary, value_set=categories).cast(pa.int32())
        return pc.take(lookup, column.indices)
    return pc.index_in(column, value_set=categories).cast(pa.int32())


@dataclass
class _Layout:
    """How the spilled columns map back to the in-memory frame's."""

    source_schema: pa.Schema
    dictionary_columns: list[str]
    feature_key: str | None
    codes_column: str | None
    categories: dict[str, pa.Array]
    #: Columns `to_pandas` turns into the index, which the sort then drops.
    index_columns: frozenset[str] = frozenset()


def _spill_batch(
    batch: pa.RecordBatch, morton: np.ndarray, layout: _Layout
) -> tuple[pa.RecordBatch, dict[str, pa.Array]]:
    """The batch as spilled: dictionaries as global codes, plus codes and Morton columns.

    Also returns the integer columns of the final frame, for the encoding plan.
    """
    arrays: list[pa.Array] = []
    names: list[str] = []
    final_integers: dict[str, pa.Array] = {}
    for name in batch.schema.names:
        column = batch.column(name)
        if name in layout.dictionary_columns:
            column = _recode(column, layout.categories[name])
        elif pa.types.is_integer(column.type) and name not in layout.index_columns:
            final_integers[name] = column
        if name == MORTON_CODE_2D_COLUMN:
            column = pa.array(morton, type=pa.uint32())
        arrays.append(column)
        names.append(name)
    if layout.codes_column is not None and layout.feature_key is not None:
        # pandas' categorical codes: -1 for a missing feature.
        codes = pc.fill_null(
            _recode(batch.column(layout.feature_key), layout.categories[layout.feature_key]), -1
        )
        arrays.append(codes)
        names.append(layout.codes_column)
        final_integers[layout.codes_column] = codes
    if MORTON_CODE_2D_COLUMN not in batch.schema.names:
        arrays.append(pa.array(morton, type=pa.uint32()))
        names.append(MORTON_CODE_2D_COLUMN)
    final_integers[MORTON_CODE_2D_COLUMN] = arrays[names.index(MORTON_CODE_2D_COLUMN)]
    return pa.RecordBatch.from_arrays(arrays, names=names), final_integers


def _to_frame(table: pa.Table, layout: _Layout) -> pd.DataFrame:
    """A spilled table as the in-memory path's frame would hold those rows."""
    for name in layout.dictionary_columns:
        index = table.schema.get_field_index(name)
        original = layout.source_schema.field(name).type
        codes = table.column(index).combine_chunks().cast(original.index_type)
        dictionary = pa.DictionaryArray.from_arrays(codes, layout.categories[name])
        table = table.set_column(index, name, dictionary)
    # Restores the source's pandas metadata so `to_pandas` matches `read_points_dataframe`.
    table = table.replace_schema_metadata(layout.source_schema.metadata)
    frame = table.to_pandas()
    if layout.codes_column is not None and layout.codes_column in frame.columns:
        frame[layout.codes_column] = frame[layout.codes_column].astype("int32")
    return frame


def _pandas_table(frame: pd.DataFrame, start: int, metadata: dict[bytes, bytes] | None) -> pa.Table:
    indexed = frame.copy()
    indexed.index = pd.RangeIndex(start, start + len(frame), name=_WRITTEN_INDEX)
    table = pa.Table.from_pandas(indexed, preserve_index=True)
    return table if metadata is None else table.replace_schema_metadata(metadata)


def _final_metadata(table: pa.Table, rows: int) -> dict[bytes, bytes]:
    """The schema metadata of the whole table: the range index spans every row."""
    metadata = dict(table.schema.metadata or {})
    pandas_meta = json.loads(metadata[b"pandas"])
    for index in pandas_meta["index_columns"]:
        if isinstance(index, dict) and index.get("kind") == "range":
            index["start"], index["stop"] = 0, rows
    metadata[b"pandas"] = json.dumps(pandas_meta).encode()
    return metadata


def _pandas_index_columns(schema: pa.Schema) -> frozenset[str]:
    raw = (schema.metadata or {}).get(b"pandas")
    if raw is None:
        return frozenset()
    return frozenset(c for c in json.loads(raw).get("index_columns", []) if isinstance(c, str))


def _raise_open_file_limit(needed: int) -> None:
    try:
        import resource
    except ImportError:  # Windows: no soft limit to raise
        return
    soft, hard = resource.getrlimit(resource.RLIMIT_NOFILE)
    if soft >= needed:
        return
    target = needed if hard == resource.RLIM_INFINITY else min(needed, hard)
    resource.setrlimit(resource.RLIMIT_NOFILE, (target, hard))
    if target < needed:
        raise ValueError(
            f"Morton spill needs {needed} open files but the limit is {target}; "
            "raise the memory budget so fewer buckets are needed."
        )


def write_morton_points_parquet_spilled(
    source: str | Path,
    output_path: str | Path,
    *,
    feature_key: str | None = None,
    row_group_size: int = 50_000,
    compression: str = "zstd",
    encodings: EncodingPolicy = "auto",
    write_page_index: bool = True,
    memory_budget: int = DEFAULT_MEMORY_BUDGET,
    temp_dir: str | Path | None = None,
    progress: Progress | None = None,
) -> dict[str, Any]:
    """Write what `write_morton_points_parquet(read_points_dataframe(source))` writes.

    *source* is a Parquet file or a directory of parts and must not be *output_path*.
    Spill files go in a fresh directory under *temp_dir* (the output's directory by
    default) and need about the Arrow size of the input, LZ4-compressed.
    """
    say = progress or (lambda _message: None)
    if row_group_size <= 0:
        raise ValueError("row_group_size must be positive")
    dataset = ds.dataset(source, format="parquet")
    schema = dataset.schema
    missing = [column for column in ("x", "y") if column not in schema.names]
    if missing:
        raise ValueError("Points dataframe is missing required columns: " + ", ".join(missing))
    width = _row_width(schema)
    bucket_rows = max(1, memory_budget // (width * _WORKING_COPIES))
    batch_rows = int(min(4_000_000, max(65_536, bucket_rows // 4)))

    has_z = "z" in schema.names
    say("morton spill: surveying input")
    survey = _survey(dataset, feature_key, has_z)
    if survey.rows == 0:
        frame = ds.dataset(source, format="parquet").to_table().to_pandas()
        write_morton_points_parquet(
            frame, output_path, feature_key=feature_key, row_group_size=row_group_size,
            compression=compression, encodings=encodings, write_page_index=write_page_index,
        )
        return {"rows": 0, "sentinel_count": 0, "buckets": 0, "encoding_plan": None}
    sentinels = survey.sentinel_rows()
    z_order = _z_sort_order(survey) if has_z else None
    keyer = _Keyer(survey, z_order)

    dictionary_columns = [n for n, t in zip(schema.names, schema.types) if pa.types.is_dictionary(t)]
    codes_column = None
    if feature_key and feature_key in schema.names and f"{feature_key}_codes" not in schema.names:
        codes_column = f"{feature_key}_codes"
    layout = _Layout(
        source_schema=schema,
        dictionary_columns=dictionary_columns,
        feature_key=feature_key,
        codes_column=codes_column,
        categories={name: pa.array(values, type=schema.field(name).type.value_type)
                    if name in dictionary_columns else pa.array(values)
                    for name, values in survey.categories.items()},
        index_columns=_pandas_index_columns(schema),
    )

    say(f"morton spill: histogram of {survey.rows:,} rows")
    xy = ["x", "y", *(["z"] if z_order is not None else [])]
    histogram = np.zeros(keyer.bins, dtype=np.int64)
    offset = 0
    for batch in dataset.to_batches(columns=xy, batch_size=batch_rows, **_READAHEAD):
        keep = _rest_mask(offset, batch.num_rows, sentinels)
        offset += batch.num_rows
        frame = batch.to_pandas()
        keys = keyer(batch, _morton(frame, survey))[keep]
        histogram += np.bincount(keys, minlength=keyer.bins)
    edges = _bucket_edges(histogram, bucket_rows)
    bucket_counts = np.add.reduceat(histogram, edges) if histogram.size else np.zeros(0)
    del histogram

    scratch_parent = Path(temp_dir) if temp_dir is not None else Path(output_path).parent
    scratch_parent.mkdir(parents=True, exist_ok=True)
    scratch = Path(tempfile.mkdtemp(prefix=".morton-spill-", dir=scratch_parent))
    try:
        _raise_open_file_limit(len(edges) + 64)
        say(f"morton spill: {len(edges)} buckets of up to {bucket_rows:,} rows in {scratch}")
        threshold = max(1, int(survey.rows * DICTIONARY_CARDINALITY_RATIO))
        counters: dict[str, _DistinctCounter] = {}
        sentinel_parts: list[pa.Table] = []
        writers: list[ipc.RecordBatchFileWriter] = []
        options = ipc.IpcWriteOptions(compression="lz4")
        offset = 0
        spill_schema: pa.Schema | None = None
        try:
            for batch in dataset.to_batches(batch_size=batch_rows, **_READAHEAD):
                frame = batch.select(xy).to_pandas()
                morton = _morton(frame, survey)
                keep = _rest_mask(offset, batch.num_rows, sentinels)
                rows = np.arange(offset, offset + batch.num_rows)
                offset += batch.num_rows
                spilled, integers = _spill_batch(batch, morton, layout)
                if not keep.all():
                    taken = pa.Table.from_batches([spilled]).filter(pa.array(~keep))
                    sentinel_parts.append(
                        taken.append_column(_ROW_COLUMN, pa.array(rows[~keep]))
                    )
                for name, values in integers.items():
                    counter = counters.setdefault(
                        name,
                        _DistinctCounter(
                            threshold,
                            # Shared by every counted column, as the bitmaps are.
                            max_values=memory_budget // (32 * max(1, len(integers))),
                            # One eighth of the budget, shared by every counted column.
                            max_bitmap_bytes=memory_budget // (8 * max(1, len(integers))),
                        ),
                    )
                    counter.add(values.filter(pa.array(keep)).drop_null().to_numpy(zero_copy_only=False))
                if spill_schema is None:
                    spill_schema = spilled.schema
                    writers = [
                        ipc.new_file(scratch / f"bucket{b}.arrow", spill_schema, options=options)
                        for b in range(len(edges))
                    ]
                bucket = np.searchsorted(edges, keyer(batch, morton), side="right") - 1
                bucket = bucket[keep]
                rest = spilled.filter(pa.array(keep))
                order = np.argsort(bucket, kind="stable")
                sorted_rest = rest.take(pa.array(order))
                bounds = np.searchsorted(bucket[order], np.arange(len(edges) + 1))
                for b in np.unique(bucket).tolist():
                    writers[b].write_batch(sorted_rest.slice(bounds[b], bounds[b + 1] - bounds[b]))
        finally:
            for writer in writers:
                writer.close()

        sentinel_table = pa.concat_tables(sentinel_parts) if sentinel_parts else None
        sentinel_frame = _sentinel_frame(sentinel_table, sentinels, layout)
        # The sentinels' final values join the distinct counts: Morton is zeroed.
        for name, counter in counters.items():
            if sentinel_frame is not None and name in sentinel_frame.columns:
                counter.add(sentinel_frame[name].dropna().to_numpy())
        sort_columns = [MORTON_CODE_2D_COLUMN] if z_order is None else ["z", MORTON_CODE_2D_COLUMN]

        def buckets(columns: list[str] | None = None) -> Iterator[pd.DataFrame]:
            for b, count in enumerate(bucket_counts):
                if not count:
                    continue
                path = scratch / f"bucket{b}.arrow"
                with pa.memory_map(str(path)) as source_file:
                    read_options = None
                    if columns is not None and spill_schema is not None:
                        fields = sorted(spill_schema.get_field_index(c) for c in columns)
                        read_options = ipc.IpcReadOptions(included_fields=fields)
                    table = ipc.open_file(source_file, options=read_options).read_all()
                if columns is not None:
                    frame = table.to_pandas()
                else:
                    frame = _to_frame(table, layout)
                del table
                yield frame.sort_values(sort_columns, kind="mergesort").reset_index(drop=True)

        plan, ordered = _plan(
            counters, threshold, survey.rows, sentinel_frame, buckets, sort_columns, encodings
        )
        say("morton spill: writing sorted buckets")
        _write(
            output_path,
            sentinel_frame,
            buckets(),
            rows=survey.rows,
            row_group_size=row_group_size,
            compression=compression,
            plan=plan,
            declare_morton_order=ordered.get(MORTON_CODE_2D_COLUMN, False),
            write_page_index=write_page_index,
            sentinel_count=len(sentinels),
        )
    finally:
        remove_tree(scratch)
    return {
        "rows": survey.rows,
        "sentinel_count": len(sentinels),
        "buckets": int(np.count_nonzero(bucket_counts)),
        "encoding_plan": plan.as_manifest() if plan is not None else None,
    }


def _sentinel_frame(
    table: pa.Table | None, sentinels: list[int], layout: _Layout
) -> pd.DataFrame | None:
    if table is None or not sentinels:
        return None
    rows = table.column(_ROW_COLUMN).to_pylist()
    table = table.drop_columns([_ROW_COLUMN])
    # `_extreme_positions` order, not input order.
    table = table.take(pa.array([rows.index(row) for row in sentinels]))
    frame = _to_frame(table, layout).reset_index(drop=True)
    frame[MORTON_CODE_2D_COLUMN] = MORTON_CODE_EXTREME_VALUE_INDICATOR
    return frame


def _plan(
    counters: dict[str, _DistinctCounter],
    threshold: int,
    rows: int,
    sentinel_frame: pd.DataFrame | None,
    buckets: Callable[[list[str] | None], Iterator[pd.DataFrame]],
    sort_columns: list[str],
    encodings: EncodingPolicy,
) -> tuple[ColumnEncodingPlan | None, dict[str, bool]]:
    """`plan_column_encodings` of the whole output, from streamed statistics.

    Order only matters for high-cardinality integers and the declared Morton order,
    so only those columns are re-read to check it.
    """
    high = [
        name for name, counter in counters.items()
        if (count := counter.count()) is None or count > threshold
    ]
    checked = sorted({*high, MORTON_CODE_2D_COLUMN})
    ordered: dict[str, bool] = {}
    last: dict[str, Any] = {}
    frames: list[pd.DataFrame] = []
    if sentinel_frame is not None:
        frames.append(sentinel_frame[checked])
    columns = sorted({*checked, *sort_columns})
    for frame in itertools.chain(frames, buckets(columns)):
        for name in checked:
            values = frame[name].to_numpy()
            if values.size == 0:
                continue
            if pd.isna(values).any():
                ordered[name] = False
                continue
            ok = ordered.get(name, True) and bool(np.all(values[1:] >= values[:-1]))
            if name in last and ok:
                ok = values[0] >= last[name]
            ordered[name] = ok
            last[name] = values[-1]
    # The written index is 0..rows-1: all distinct and ascending.
    if rows > threshold:
        high.append(_WRITTEN_INDEX)
        ordered[_WRITTEN_INDEX] = True
    if encodings != "auto":
        return None, ordered
    return _encoding_plan(sentinel_frame, buckets, high, ordered), ordered


def _encoding_plan(
    sentinel_frame: pd.DataFrame | None,
    buckets: Callable[[list[str] | None], Iterator[pd.DataFrame]],
    high: list[str],
    ordered: dict[str, bool],
) -> ColumnEncodingPlan:
    # The column types come from the first converted frame; any frame gives the same.
    frame = sentinel_frame if sentinel_frame is not None else next(buckets(None), None)
    if frame is None:
        return ColumnEncodingPlan()
    schema = _pandas_table(_move_string_like_columns_right(frame.head(0)), 0, None).schema
    use_dictionary: list[str] = []
    column_encoding: dict[str, str] = {}
    for name, column_type in zip(schema.names, schema.types):
        if pa.types.is_floating(column_type):
            column_encoding[name] = "BYTE_STREAM_SPLIT"
        elif pa.types.is_integer(column_type) and name in high:
            column_encoding[name] = "DELTA_BINARY_PACKED" if ordered.get(name) else "PLAIN"
        else:
            use_dictionary.append(name)
    return ColumnEncodingPlan(use_dictionary=use_dictionary, column_encoding=column_encoding)


def _write(
    output_path: str | Path,
    sentinel_frame: pd.DataFrame | None,
    buckets: Iterator[pd.DataFrame],
    *,
    rows: int,
    row_group_size: int,
    compression: str,
    plan: ColumnEncodingPlan | None,
    declare_morton_order: bool,
    write_page_index: bool,
    sentinel_count: int,
) -> None:
    output = Path(output_path)
    output.parent.mkdir(parents=True, exist_ok=True)
    writer: pq.ParquetWriter | None = None
    metadata: dict[bytes, bytes] | None = None
    written = 0
    pending: list[pa.Table] = []
    pending_rows = 0

    def open_writer(table: pa.Table) -> pq.ParquetWriter:
        nonlocal metadata
        metadata = _final_metadata(table, rows)
        schema = table.schema.with_metadata(metadata)
        options: dict[str, Any] = {}
        if plan is not None:
            options = {"use_dictionary": plan.use_dictionary, "column_encoding": plan.column_encoding}
        if declare_morton_order:
            index = schema.get_field_index(MORTON_CODE_2D_COLUMN)
            options["sorting_columns"] = [pq.SortingColumn(index, descending=False)]
        return pq.ParquetWriter(
            output,
            schema,
            compression=compression,
            write_statistics=True,
            write_page_index=write_page_index,
            **options,
        )

    def table_of(frame: pd.DataFrame) -> pa.Table:
        nonlocal writer, written
        # `morton_sort_points` records this in attrs, which pandas metadata carries.
        frame.attrs[MORTON_SENTINEL_COUNT_ATTR] = sentinel_count
        table = _pandas_table(_move_string_like_columns_right(frame), written, metadata)
        if writer is None:
            writer = open_writer(table)
            table = table.replace_schema_metadata(metadata)
        elif not table.schema.equals(writer.schema, check_metadata=False):
            # A column that is all null in this bucket converts to the null type.
            table = table.cast(writer.schema)
        written += len(frame)
        return table

    try:
        if sentinel_frame is not None:
            table = table_of(sentinel_frame)
            assert writer is not None
            writer.write_table(table, row_group_size=table.num_rows)
        for frame in buckets:
            pending.append(table_of(frame))
            pending_rows += pending[-1].num_rows
            del frame
            while pending_rows >= row_group_size:
                combined = pa.concat_tables(pending)
                cut = (pending_rows // row_group_size) * row_group_size
                for start in range(0, cut, row_group_size):
                    chunk = combined.slice(start, row_group_size)
                    assert writer is not None
                    writer.write_table(chunk, row_group_size=chunk.num_rows)
                rest = combined.slice(cut)
                pending = [rest] if rest.num_rows else []
                pending_rows = rest.num_rows
        if pending_rows:
            assert writer is not None
            chunk = pa.concat_tables(pending)
            writer.write_table(chunk, row_group_size=chunk.num_rows)
    finally:
        if writer is not None:
            writer.close()
