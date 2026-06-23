from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

import pandas as pd
import pyarrow as pa
import pyarrow.parquet as pq

from spatialdata_experimental_writer.index_permutations import write_index_permutations
from spatialdata_experimental_writer.errors import WriterCommandError
from spatialdata_experimental_writer.points import MORTON_CODE_2D_COLUMN, write_morton_points_parquet
from spatialdata_experimental_writer.runners import run_morton_points_from_zarr
from spatialdata_experimental_writer.zarr import list_points_keys


def _write_points_element(
    zarr_root: Path,
    key: str,
    *,
    feature_key: str = "feature_name",
    rows: int = 200,
) -> None:
    element_dir = zarr_root / "points" / key
    parquet_path = element_dir / "points.parquet"
    element_dir.mkdir(parents=True)
    rng = pd.Series(range(rows))
    table = pa.Table.from_pandas(
        pd.DataFrame(
            {
                "x": (rng.astype("float64") % 100).tolist(),
                "y": ((rng * 3).astype("float64") % 100).tolist(),
                "feature_name": (["gene_a", "gene_b", "gene_c"] * rows)[:rows],
            }
        ),
        preserve_index=False,
    )
    pq.write_table(table, parquet_path)
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
    zarr_root.joinpath("zarr.json").write_text(
        json.dumps({"zarr_format": 3, "node_type": "group"})
    )


def test_morton_parquet_does_not_persist_uint_columns(tmp_path: Path) -> None:
    df = pd.DataFrame(
        {
            "x": [0.0, 10.0, 5.0, 2.0, 8.0],
            "y": [3.0, 4.0, 20.0, 0.0, 9.0],
            "feature_name": ["b", "a", "b", "c", "a"],
        }
    )
    output = tmp_path / "points.parquet"
    write_morton_points_parquet(df, output, feature_key="feature_name", row_group_size=2)
    columns = pq.ParquetFile(output).schema_arrow.names
    assert "x_uint" not in columns
    assert "y_uint" not in columns
    assert MORTON_CODE_2D_COLUMN in columns
    assert "feature_name_codes" in columns


def test_morton_points_from_zarr_defaults_to_canonical_path(tmp_path: Path) -> None:
    zarr_root = tmp_path / "store.zarr"
    _write_points_element(zarr_root, "transcripts")
    canonical = zarr_root / "points" / "transcripts" / "points.parquet"

    subprocess.run(
        [
            sys.executable,
            "-m",
            "spatialdata_experimental_writer.cli",
            "morton-points-from-zarr",
            str(zarr_root),
            "--points-key",
            "transcripts",
            "--row-group-size",
            "50",
        ],
        check=True,
        cwd=Path(__file__).resolve().parents[1],
    )

    assert canonical.is_file()
    columns = pq.ParquetFile(canonical).schema_arrow.names
    assert MORTON_CODE_2D_COLUMN in columns
    assert "feature_name_codes" in columns


def test_cli_expected_error_has_no_traceback(tmp_path: Path) -> None:
    missing = tmp_path / "missing.zarr"

    result = subprocess.run(
        [
            sys.executable,
            "-m",
            "spatialdata_experimental_writer.cli",
            "list-points",
            str(missing),
        ],
        check=False,
        cwd=Path(__file__).resolve().parents[1],
        capture_output=True,
        text=True,
    )

    assert result.returncode != 0
    assert "No Points elements found" in result.stderr
    assert "Traceback" not in result.stderr


def test_morton_points_from_zarr_output_points_key_writes_element(tmp_path: Path) -> None:
    zarr_root = tmp_path / "store.zarr"
    _write_points_element(zarr_root, "transcripts")

    result = run_morton_points_from_zarr(
        zarr_root,
        points_key="transcripts",
        output_points_key="transcripts_morton",
        row_group_size=50,
    )

    output = zarr_root / "points" / "transcripts_morton" / "points.parquet"
    assert result["output_points_key"] == "transcripts_morton"
    assert result["output"] == str(output)
    assert output.is_file()
    assert (zarr_root / "points" / "transcripts_morton" / "zarr.json").is_file()
    assert list_points_keys(zarr_root) == ["transcripts", "transcripts_morton"]
    metadata = json.loads(zarr_root.joinpath("zarr.json").read_text())[
        "consolidated_metadata"
    ]["metadata"]
    assert "points/transcripts_morton" in metadata


def test_morton_points_from_zarr_output_points_key_can_be_experimental(
    tmp_path: Path,
) -> None:
    zarr_root = tmp_path / "store.zarr"
    _write_points_element(zarr_root, "transcripts")

    result = run_morton_points_from_zarr(
        zarr_root,
        points_key="transcripts",
        experimental=True,
        output_points_key="transcripts_morton",
        row_group_size=50,
    )

    output = zarr_root / "points.experimental" / "transcripts_morton" / "points.parquet"
    assert result["output_collection"] == "points.experimental"
    assert result["output_points_key"] == "transcripts_morton"
    assert result["output"] == str(output)
    assert output.is_file()
    assert not (zarr_root / "points" / "transcripts_morton").exists()


def test_morton_points_from_zarr_requires_overwrite_for_existing_output_element(
    tmp_path: Path,
) -> None:
    zarr_root = tmp_path / "store.zarr"
    _write_points_element(zarr_root, "transcripts")
    _write_points_element(zarr_root, "transcripts_morton")

    try:
        run_morton_points_from_zarr(
            zarr_root,
            points_key="transcripts",
            output_points_key="transcripts_morton",
            row_group_size=50,
        )
    except WriterCommandError as exc:
        assert "already exists" in str(exc)
    else:
        raise AssertionError("expected WriterCommandError")

    run_morton_points_from_zarr(
        zarr_root,
        points_key="transcripts",
        output_points_key="transcripts_morton",
        overwrite=True,
        row_group_size=50,
    )
    assert (zarr_root / "points" / "transcripts_morton" / "points.parquet").is_file()


def test_write_index_permutations_writes_manifest(tmp_path: Path) -> None:
    source = tmp_path / "source.zarr"
    dest = tmp_path / "dest.zarr"
    _write_points_element(source, "transcripts", rows=120)

    manifest = write_index_permutations(
        source,
        dest,
        points_key="transcripts",
        row_group_size=40,
        conditions=tuple(
            condition
            for condition in __import__(
                "spatialdata_experimental_writer.index_permutations",
                fromlist=["DEFAULT_CONDITIONS"],
            ).DEFAULT_CONDITIONS
            if condition.id in {"canonical", "morton"}
        ),
    )

    assert (dest / "index-manifest.json").exists()
    assert manifest["source_element"] == "points/transcripts"
    assert (dest / "points" / "transcripts" / "points.parquet").exists()
    assert (dest / "points" / "transcripts_morton" / "points.parquet").exists()
    assert list_points_keys(dest) == ["transcripts", "transcripts_morton"]
    consolidated = json.loads((dest / "zarr.json").read_text())["consolidated_metadata"][
        "metadata"
    ]
    assert "points/transcripts_morton" in consolidated
    morton_columns = pq.ParquetFile(
        dest / "points" / "transcripts_morton" / "points.parquet"
    ).schema_arrow.names
    assert MORTON_CODE_2D_COLUMN in morton_columns
