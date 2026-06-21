from __future__ import annotations

import json

import pandas as pd
import pyarrow.parquet as pq

from spatialdata_experimental_writer import (
    MORTON_CODE_2D_COLUMN,
    build_spatialdata_multiscale_metadata,
    morton_sort_points,
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
