from __future__ import annotations

import json

import pandas as pd
import pyarrow as pa
import pyarrow.parquet as pq

from spatialdata_experimental_writer.index_permutations import write_index_permutations
from spatialdata_experimental_writer.points import (
    MORTON_CODE_2D_COLUMN,
    build_spatialdata_multiscale_metadata,
    write_morton_points_parquet,
    write_multiscale_points_parquet,
)
from spatialdata_experimental_writer.verify import (
    all_passed,
    verify_index_permutations_manifest,
    verify_morton_parquet,
    verify_multiscale_parquet,
)


def test_verify_morton_parquet_passes_for_writer_output(tmp_path) -> None:
    df = pd.DataFrame(
        {
            "x": [0.0, 10.0, 5.0, 2.0, 8.0],
            "y": [3.0, 4.0, 20.0, 0.0, 9.0],
            "feature_name": ["b", "a", "b", "c", "a"],
        }
    )
    output = tmp_path / "points.parquet"
    write_morton_points_parquet(df, output, feature_key="feature_name", row_group_size=2)

    checks = verify_morton_parquet(output)
    assert all_passed(checks)


def test_verify_morton_parquet_fails_for_unsorted_tail(tmp_path) -> None:
    rows = 40
    rng = pd.Series(range(rows))
    df = pd.DataFrame(
        {
            "x": (rng.astype("float64") % 20).tolist(),
            "y": ((rng * 3).astype("float64") % 20).tolist(),
            "feature_name": (["a", "b", "c"] * rows)[:rows],
        }
    )
    output = tmp_path / "points.parquet"
    write_morton_points_parquet(df, output, feature_key="feature_name", row_group_size=8)

    table = pq.read_table(output)
    pdf = table.to_pandas()
    sentinel_count = int((pdf[MORTON_CODE_2D_COLUMN].head(4) == 0).sum())
    assert sentinel_count < len(pdf) - 1
    later = sentinel_count + 1
    pdf.at[pdf.index[later], MORTON_CODE_2D_COLUMN] = int(
        pdf[MORTON_CODE_2D_COLUMN].iloc[sentinel_count]
    ) - 1
    pq.write_table(pa.Table.from_pandas(pdf, preserve_index=False), output)

    checks = verify_morton_parquet(output)
    monotonic = next(check for check in checks if check.id == "morton_monotonic")
    assert not monotonic.passed


def test_verify_multiscale_parquet(tmp_path) -> None:
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

    checks = verify_multiscale_parquet(output)
    assert all_passed(checks)


def test_verify_index_permutations_manifest(tmp_path) -> None:
    source = tmp_path / "source.zarr"
    dest = tmp_path / "dest.zarr"
    element_dir = source / "points" / "transcripts"
    element_dir.mkdir(parents=True)
    df = pd.DataFrame(
        {
            "x": [0.0, 10.0, 5.0, 2.0],
            "y": [3.0, 4.0, 20.0, 0.0],
            "feature_name": ["b", "a", "b", "c"],
        }
    )
    pq.write_table(pa.Table.from_pandas(df, preserve_index=False), element_dir / "points.parquet")
    element_dir.joinpath("zarr.json").write_text(
        json.dumps(
            {
                "attributes": {
                    "encoding-type": "ngff:points",
                    "axes": ["x", "y"],
                    "spatialdata_attrs": {"feature_key": "feature_name", "version": "0.2"},
                },
                "zarr_format": 3,
                "node_type": "group",
            }
        )
    )
    source.joinpath("zarr.json").write_text(
        json.dumps({"zarr_format": 3, "node_type": "group"})
    )

    write_index_permutations(
        source,
        dest,
        points_key="transcripts",
        row_group_size=2,
        conditions=tuple(
            condition
            for condition in __import__(
                "spatialdata_experimental_writer.index_permutations",
                fromlist=["DEFAULT_CONDITIONS"],
            ).DEFAULT_CONDITIONS
            if condition.id in {"canonical", "morton"}
        ),
    )

    checks = verify_index_permutations_manifest(dest)
    morton_checks = [check for check in checks if check.id.endswith("morton_monotonic")]
    assert morton_checks
    assert all(check.passed for check in morton_checks)
