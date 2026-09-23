from __future__ import annotations

import json

import pandas as pd
import pyarrow.parquet as pq

import numpy as np
import pyarrow as pa
import pytest

from spatialdata_js_util import (
    MORTON_CODE_2D_COLUMN,
    MORTON_COARSE_COLUMN,
    build_spatialdata_multiscale_metadata,
    morton_sort_points,
    plan_column_encodings,
    write_morton_points_parquet,
    write_multiscale_points_parquet,
)


def test_morton_sort_points_adds_sentinel_rows_and_feature_codes() -> None:
    df = pd.DataFrame(
        {
            "x": [0.0, 10.0, 5.0, 2.0],
            "y": [3.0, 4.0, 20.0, 0.0],
            "feature_name": ["b", "a", "b", "c"],
        }
    )

    sorted_df = morton_sort_points(df, feature_key="feature_name")

    assert MORTON_CODE_2D_COLUMN in sorted_df.columns
    assert "feature_name_codes" in sorted_df.columns
    assert sorted_df[MORTON_CODE_2D_COLUMN].iloc[:4].eq(0).all()
    assert sorted_df.columns[-1] == "feature_name"


def test_morton_sort_points_uses_extreme_row_positions_not_duplicate_index_labels() -> None:
    df = pd.DataFrame(
        {
            "x": [0.0, 50.0, 100.0, 25.0, 75.0, 10.0],
            "y": [50.0, 100.0, 25.0, 0.0, 75.0, 10.0],
            "feature_name": ["x_min", "y_max", "x_max", "y_min", "other", "near_min"],
        },
        index=[7, 7, 8, 8, 9, 9],
    )

    sorted_df = morton_sort_points(df, feature_key="feature_name")

    sentinel = sorted_df.iloc[:4]
    assert sentinel[MORTON_CODE_2D_COLUMN].eq(0).all()
    assert sentinel["x"].min() == 0.0
    assert sentinel["x"].max() == 100.0
    assert sentinel["y"].min() == 0.0
    assert sentinel["y"].max() == 100.0
    assert sorted_df["feature_name"].value_counts().to_dict() == {
        "x_min": 1,
        "y_max": 1,
        "x_max": 1,
        "y_min": 1,
        "other": 1,
        "near_min": 1,
    }


def test_write_morton_points_parquet_uses_small_sentinel_row_group(tmp_path) -> None:
    df = pd.DataFrame(
        {
            "x": [0.0, 10.0, 5.0, 2.0, 8.0],
            "y": [3.0, 4.0, 20.0, 0.0, 9.0],
            "feature_name": ["b", "a", "b", "c", "a"],
        }
    )
    output = tmp_path / "points.parquet"

    write_morton_points_parquet(df, output, feature_key="feature_name", row_group_size=2)

    parquet = pq.ParquetFile(output)
    assert parquet.num_row_groups >= 2
    assert parquet.metadata.row_group(0).num_rows <= 4


def test_write_morton_points_parquet_keeps_quantized_zero_points_out_of_sentinel_row_group(
    tmp_path,
) -> None:
    df = pd.DataFrame(
        {
            "x": [0.0, 10.0, 0.00001, 5.0, 2.0],
            "y": [0.0, 20.0, 0.00001, 10.0, 7.0],
            "feature_name": ["min", "max", "near_min", "mid", "other"],
        }
    )
    output = tmp_path / "points.parquet"

    sorted_df = write_morton_points_parquet(
        df,
        output,
        feature_key="feature_name",
        row_group_size=2,
    )

    assert sorted_df[MORTON_CODE_2D_COLUMN].iloc[:3].eq(0).all()
    parquet = pq.ParquetFile(output)
    assert parquet.metadata.row_group(0).num_rows == 2


def test_write_multiscale_points_parquet_stores_metadata(tmp_path) -> None:
    df = pd.DataFrame(
        {
            "x": [0.0, 10.0],
            "y": [3.0, 4.0],
            "__spatial_index__": [0, 1],
            "__morton__": [0, 1],
        }
    )
    output = tmp_path / "points.parquet"
    metadata = build_spatialdata_multiscale_metadata(df, axes=("x", "y"))

    write_multiscale_points_parquet(df, output, metadata=metadata, row_group_size=2)

    schema_metadata = pq.ParquetFile(output).schema_arrow.metadata
    assert schema_metadata is not None
    stored = json.loads(schema_metadata[b"spatialdata_multiscale"])
    assert stored["format"] == "spatialdata_multiscale_points"
    assert stored["bounding_box"]["min"] == [0.0, 3.0]


def _encodings_by_column(path) -> dict[str, tuple[str, ...]]:
    row_group = pq.ParquetFile(path).metadata.row_group(0)
    return {
        row_group.column(i).path_in_schema: tuple(row_group.column(i).encodings)
        for i in range(row_group.num_columns)
    }


def _points_frame(rows: int = 400) -> pd.DataFrame:
    rng = np.random.default_rng(0)
    return pd.DataFrame(
        {
            "x": rng.uniform(0, 1000, rows).astype("float32"),
            "y": rng.uniform(0, 1000, rows).astype("float32"),
            "z": rng.uniform(0, 30, rows).astype("float32"),
            "transcript_id": rng.integers(0, 2**62, rows).astype("uint64"),
            "feature_name": pd.Categorical(
                [f"gene{i % 17}" for i in range(rows)]
            ),
        }
    )


def test_plan_column_encodings_drops_the_dictionary_only_where_it_loses() -> None:
    rows = 2000
    rng = np.random.default_rng(1)
    table = pa.table(
        {
            "coord": pa.array(rng.uniform(0, 1, rows).astype(np.float32)),
            "sorted_id": pa.array(np.sort(rng.integers(0, 2**31, rows)).astype(np.uint32)),
            "random_id": pa.array(rng.integers(0, 2**62, rows).astype(np.uint64)),
            "code": pa.array(rng.integers(0, 20, rows).astype(np.int32)),
            "name": pa.array([f"g{i % 11}" for i in range(rows)]),
        }
    )

    plan = plan_column_encodings(table)

    assert plan.column_encoding == {
        "coord": "BYTE_STREAM_SPLIT",
        "sorted_id": "DELTA_BINARY_PACKED",
        "random_id": "PLAIN",
    }
    # Low-cardinality codes and strings are what the dictionary is for.
    assert sorted(plan.use_dictionary) == ["code", "name"]


def test_write_morton_points_parquet_encodes_coordinates_without_a_dictionary(
    tmp_path,
) -> None:
    output = tmp_path / "points.parquet"
    write_morton_points_parquet(_points_frame(), output, feature_key="feature_name")

    encodings = _encodings_by_column(output)
    for column in ("x", "y", "z"):
        assert "BYTE_STREAM_SPLIT" in encodings[column]
        assert "RLE_DICTIONARY" not in encodings[column]
    assert "DELTA_BINARY_PACKED" in encodings[MORTON_CODE_2D_COLUMN]
    assert "PLAIN" in encodings["transcript_id"]
    assert "RLE_DICTIONARY" not in encodings["transcript_id"]
    # 17 genes over 400 rows: the dictionary still earns its place here.
    assert "RLE_DICTIONARY" in encodings["feature_name_codes"]


def test_write_morton_points_parquet_is_smaller_than_the_pyarrow_defaults(
    tmp_path,
) -> None:
    df = _points_frame(rows=20_000)
    tuned = tmp_path / "tuned.parquet"
    default = tmp_path / "default.parquet"
    write_morton_points_parquet(df, tuned, feature_key="feature_name")
    write_morton_points_parquet(
        df, default, feature_key="feature_name", encodings="pyarrow-default"
    )

    assert tuned.stat().st_size < default.stat().st_size


def test_write_morton_points_parquet_writes_a_page_index(tmp_path) -> None:
    output = tmp_path / "points.parquet"
    write_morton_points_parquet(_points_frame(), output, feature_key="feature_name")

    row_group = pq.ParquetFile(output).metadata.row_group(0)
    assert all(row_group.column(i).has_offset_index for i in range(row_group.num_columns))


def test_write_morton_points_parquet_declares_a_sort_order_it_honours(tmp_path) -> None:
    morton_primary = tmp_path / "morton.parquet"
    feature_primary = tmp_path / "feature.parquet"
    df = _points_frame()
    write_morton_points_parquet(df, morton_primary, feature_key="feature_name")
    write_morton_points_parquet(
        df,
        feature_primary,
        feature_key="feature_name",
        sort_order=["feature_name_codes", MORTON_CODE_2D_COLUMN],
    )

    declared = pq.ParquetFile(morton_primary).metadata.row_group(0).sorting_columns
    assert [column.column_index for column in declared] == [
        pq.ParquetFile(morton_primary).schema_arrow.names.index(MORTON_CODE_2D_COLUMN)
    ]
    # The sentinel rows carry their own feature codes, so a feature-primary file
    # does not ascend in that column and must not claim to.
    assert not pq.ParquetFile(feature_primary).metadata.row_group(0).sorting_columns


def test_morton_coarsening_groups_features_within_a_spatial_bucket(tmp_path) -> None:
    output = tmp_path / "points.parquet"
    sorted_df = write_morton_points_parquet(
        _points_frame(rows=2000),
        output,
        feature_key="feature_name",
        sort_order=[MORTON_COARSE_COLUMN, "feature_name_codes", MORTON_CODE_2D_COLUMN],
        morton_coarsen_levels=6,
    )

    # The key is transient: recoverable by shifting, so it never reaches the wire.
    assert MORTON_COARSE_COLUMN not in sorted_df.columns
    assert MORTON_COARSE_COLUMN not in pq.ParquetFile(output).schema_arrow.names

    body = sorted_df.iloc[4:]
    coarse = body[MORTON_CODE_2D_COLUMN].to_numpy() >> 12
    codes = body["feature_name_codes"].to_numpy()
    # Within each bucket the feature codes ascend: that contiguity is the whole
    # point of the condition.
    for bucket in np.unique(coarse):
        bucket_codes = codes[coarse == bucket]
        assert np.all(bucket_codes[1:] >= bucket_codes[:-1])


@pytest.mark.parametrize("levels", [0, 16])
def test_morton_sort_points_rejects_out_of_range_coarsening(levels: int) -> None:
    with pytest.raises(ValueError, match="morton_coarsen_levels"):
        morton_sort_points(_points_frame(rows=8), morton_coarsen_levels=levels)
