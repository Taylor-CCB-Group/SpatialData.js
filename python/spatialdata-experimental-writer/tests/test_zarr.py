from __future__ import annotations

import json
from pathlib import Path

import pandas as pd
import pyarrow as pa
import pyarrow.parquet as pq

from spatialdata_experimental_writer.zarr import (
    experimental_points_output_path,
    list_points_keys,
    points_parquet_path,
    read_points_dataframe,
    read_points_element_attrs,
)


def _write_points_element(
    zarr_root: Path,
    key: str,
    *,
    feature_key: str = "feature_name",
) -> None:
    element_dir = zarr_root / "points" / key
    parquet_dir = element_dir / "points.parquet"
    parquet_dir.mkdir(parents=True)
    table = pa.Table.from_pandas(
        pd.DataFrame(
            {
                "x": [0.0, 1.0],
                "y": [2.0, 3.0],
                "feature_name": ["a", "b"],
            }
        ),
        preserve_index=False,
    )
    pq.write_table(table, parquet_dir / "part.0.parquet")
    element_dir.joinpath("zarr.json").write_text(
        json.dumps(
            {
                "attributes": {
                    "encoding-type": "ngff:points",
                    "axes": ["x", "y"],
                    "spatialdata_attrs": {
                        "feature_key": feature_key,
                        "version": "0.2",
                    },
                },
                "zarr_format": 3,
                "node_type": "group",
            }
        )
    )


def test_list_points_keys_and_read_element(tmp_path: Path) -> None:
    _write_points_element(tmp_path, "transcripts")
    assert list_points_keys(tmp_path) == ["transcripts"]
    attrs = read_points_element_attrs(tmp_path, "transcripts")
    assert attrs["feature_key"] == "feature_name"
    df = read_points_dataframe(points_parquet_path(tmp_path, "transcripts"))
    assert list(df.columns) == ["x", "y", "feature_name"]
    assert experimental_points_output_path(tmp_path, "transcripts") == (
        tmp_path / "points.experimental" / "transcripts" / "points.parquet"
    )
