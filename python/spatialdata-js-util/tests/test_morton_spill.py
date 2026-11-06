from __future__ import annotations

from pathlib import Path

import numpy as np
import pandas as pd
import pyarrow as pa
import pyarrow.parquet as pq
import pytest

from spatialdata_js_util.morton_spill import write_morton_points_parquet_spilled
from spatialdata_js_util.points import write_morton_points_parquet
from spatialdata_js_util.store import read_points_dataframe


def _parts(directory: Path, frames: list[pd.DataFrame], index: str | None = None) -> Path:
    directory.mkdir(parents=True)
    for number, frame in enumerate(frames):
        table = pa.Table.from_pandas(frame, preserve_index=index is not None)
        pq.write_table(table, directory / f"part.{number}.parquet", row_group_size=700)
    return directory


def _frame(rng: np.random.Generator, rows: int, *, genes: list[str], z_levels: int | None) -> pd.DataFrame:
    frame = pd.DataFrame(
        {
            "x": rng.uniform(0, 1000, rows).astype("float32"),
            "y": rng.uniform(-50, 400, rows).astype("float32"),
            "feature_name": pd.Categorical(rng.choice(genes, rows)),
            "cell_id": rng.integers(0, 40, rows),
            "transcript_id": rng.permutation(rows).astype("int64") * 7919,
            "overlaps_nucleus": rng.random(rows) > 0.5,
        }
    )
    if z_levels is None:
        frame.insert(2, "z", rng.uniform(0, 10, rows).astype("float32"))
    else:
        frame.insert(2, "z", rng.integers(0, z_levels, rows).astype("float32"))
    # Duplicate coordinates, so the stable sort's tie order is exercised.
    frame.loc[frame.index[::17], ["x", "y"]] = frame.loc[frame.index[0], ["x", "y"]].to_numpy()
    return frame


def _assert_same_file(expected: Path, actual: Path) -> None:
    left, right = pq.ParquetFile(expected), pq.ParquetFile(actual)
    assert right.schema_arrow.equals(left.schema_arrow, check_metadata=True)
    assert right.metadata.num_row_groups == left.metadata.num_row_groups
    for group in range(left.metadata.num_row_groups):
        a, b = left.metadata.row_group(group), right.metadata.row_group(group)
        assert a.num_rows == b.num_rows
        for column in range(a.num_columns):
            assert a.column(column).encodings == b.column(column).encodings
    assert right.metadata.row_group(0).sorting_columns == left.metadata.row_group(0).sorting_columns
    assert right.read().equals(left.read())
    assert actual.read_bytes() == expected.read_bytes()


@pytest.mark.parametrize(
    ("z_levels", "string_feature", "with_index"),
    [(None, False, True), (5, False, False), (None, True, False)],
)
def test_spilled_matches_in_memory(
    tmp_path: Path, z_levels: int | None, string_feature: bool, with_index: bool
) -> None:
    rng = np.random.default_rng(7)
    # Parts with different gene subsets, so their dictionaries disagree.
    frames = [
        _frame(rng, 3000, genes=["b", "a", "c"], z_levels=z_levels),
        _frame(rng, 2500, genes=["d", "a", "e", "f"], z_levels=z_levels),
        _frame(rng, 1800, genes=["g", "c"], z_levels=z_levels),
    ]
    frames[1].loc[frames[1].index[5:9], "feature_name"] = None
    if string_feature:
        for frame in frames:
            frame["feature_name"] = frame["feature_name"].astype(object)
    if with_index:
        offset = 0
        for frame in frames:
            frame.index = pd.RangeIndex(offset, offset + len(frame), name="__null_dask_index__")
            offset += len(frame)
    source = _parts(tmp_path / "points.parquet", frames, "__null_dask_index__" if with_index else None)

    expected = tmp_path / "expected.parquet"
    write_morton_points_parquet(
        read_points_dataframe(source), expected, feature_key="feature_name", row_group_size=333
    )
    actual = tmp_path / "out" / "actual.parquet"
    result = write_morton_points_parquet_spilled(
        source,
        actual,
        feature_key="feature_name",
        row_group_size=333,
        memory_budget=60_000,  # a few hundred rows a bucket
    )
    assert result["buckets"] > 5
    _assert_same_file(expected, actual)
    assert not any(path.name.startswith(".morton-spill-") for path in actual.parent.iterdir())


def test_spilled_handles_an_empty_input(tmp_path: Path) -> None:
    frame = pd.DataFrame({"x": pd.Series([], dtype="float32"), "y": pd.Series([], dtype="float32")})
    source = _parts(tmp_path / "points.parquet", [frame])
    result = write_morton_points_parquet_spilled(source, tmp_path / "out.parquet")
    assert result["rows"] == 0
    assert pq.ParquetFile(tmp_path / "out.parquet").metadata.num_rows == 0
