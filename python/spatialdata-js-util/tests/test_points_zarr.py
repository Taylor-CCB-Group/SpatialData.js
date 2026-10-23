"""The points-zarr writer, checked against the spec's invariants by reading back."""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

import numpy as np
import pandas as pd
import pytest
import zarr

from spatialdata_js_util import write_points_zarr, write_points_zarr_store

GENES = ["Alpha", "Beta", "Gamma", "Delta"]


def _points(n: int = 6000, seed: int = 3) -> pd.DataFrame:
    rng = np.random.default_rng(seed)
    return pd.DataFrame(
        {
            "x": rng.uniform(0, 1000, n),
            "y": rng.uniform(0, 600, n),
            "z": rng.uniform(-5, 5, n),
            "gene": pd.Categorical(
                rng.choice(GENES, n, p=[0.6, 0.25, 0.1, 0.05]), categories=GENES
            ),
        }
    )


def _column(order: zarr.Group, name: str) -> np.ndarray:
    names = list(order["columns"][:])
    member = order[f"column_{names.index(name)}"]
    return member["codes"][:] if isinstance(member, zarr.Group) else member[:]


def _tiles(level: zarr.Group, entry: dict, order: zarr.Group) -> np.ndarray:
    grid = entry["points:grid"]
    (x0, y0), size, (ny, nx) = grid["origin"], grid["tile_size"], grid["shape"]
    tx = np.clip(((_column(order, "x") - x0) // size).astype(np.int64), 0, nx - 1)
    ty = np.clip(((_column(order, "y") - y0) // size).astype(np.int64), 0, ny - 1)
    return ty * nx + tx


@pytest.fixture
def element(tmp_path: Path) -> tuple[zarr.Group, pd.DataFrame]:
    df = _points()
    write_points_zarr(
        df,
        tmp_path / "transcripts",
        feature_key="gene",
        coordinates=("x", "y", "z"),
        n_levels=3,
        chunk_rows=256,
        shard_chunks=4,
    )
    return zarr.open_group(tmp_path / "transcripts", mode="r"), df


def test_metadata_declares_the_format(element: tuple[zarr.Group, pd.DataFrame]) -> None:
    group, df = element
    attrs = group.attrs.asdict()
    assert attrs["points:version"] == "0.1"
    assert attrs["spatialdata_attrs"] == {"feature_key": "gene", "version": "0.3-zarr"}
    assert attrs["axes"] == ["x", "y", "z"]
    assert attrs["points:n_points"] == len(df)
    layout = attrs["multiscales"]["layout"]
    assert [e["asset"] for e in layout] == ["0", "1", "2"]
    assert [e["points:grid"]["tile_size"] for e in layout] == [100.0, 200.0, 400.0]
    assert layout[0]["points:n_points"] == len(df)


def test_level_zero_holds_every_point_once_in_each_order(
    element: tuple[zarr.Group, pd.DataFrame],
) -> None:
    group, df = element
    expected = sorted(
        zip(df["x"].astype(np.float32), df["y"].astype(np.float32), df["gene"].cat.codes)
    )
    for order in ("tile_major", "feature_major"):
        o = group["0"][order]
        got = sorted(zip(_column(o, "x"), _column(o, "y"), _column(o, "gene")))
        assert got == expected, order
        assert list(o["column_3"]["enum_values"][:]) == GENES


def test_orders_are_sorted_and_indexed(element: tuple[zarr.Group, pd.DataFrame]) -> None:
    group, _ = element
    for entry in group.attrs["multiscales"]["layout"]:
        level = group[entry["asset"]]
        tm, fm, index = level["tile_major"], level["feature_major"], level["index"]
        tm_tile, tm_code = _tiles(level, entry, tm), _column(tm, "gene").astype(np.int64)
        fm_tile, fm_code = _tiles(level, entry, fm), _column(fm, "gene").astype(np.int64)
        n_tiles = int(np.prod(entry["points:grid"]["shape"]))

        assert np.all(np.diff(tm_tile * len(GENES) + tm_code) >= 0)
        assert np.all(np.diff(fm_code * n_tiles + fm_tile) >= 0)

        tile_rows = index["tile_rows"][:].astype(np.int64)
        assert np.array_equal(np.diff(tile_rows), np.bincount(tm_tile, minlength=n_tiles))
        feature_rows = index["feature_rows"][:].astype(np.int64)
        assert np.array_equal(np.diff(feature_rows), np.bincount(fm_code, minlength=len(GENES)))

        ptr = index["feature_tile_ptr"][:].astype(np.int64)
        tiles = index["feature_tile"][:]
        counts = index["feature_tile_count"][:]
        for f in range(len(GENES)):
            run = slice(feature_rows[f], feature_rows[f + 1])
            got_tiles, got_counts = np.unique(fm_tile[run], return_counts=True)
            assert np.array_equal(tiles[ptr[f] : ptr[f + 1]], got_tiles)
            assert np.array_equal(counts[ptr[f] : ptr[f + 1]], got_counts)


def test_ids_point_at_level_zero_and_levels_nest(
    element: tuple[zarr.Group, pd.DataFrame],
) -> None:
    group, df = element
    tm0 = group["0"]["tile_major"]
    x0, y0 = _column(tm0, "x"), _column(tm0, "y")
    previous: set[int] | None = None
    for entry in group.attrs["multiscales"]["layout"]:
        fm = group[entry["asset"]]["feature_major"]
        ids = _column(fm, "id").astype(np.int64)
        assert np.array_equal(_column(fm, "x"), x0[ids])
        assert np.array_equal(_column(fm, "y"), y0[ids])
        current = set(ids.tolist())
        if previous is not None:
            assert current <= previous
            # A uniform quarter, loosely.
            assert 0.15 < len(current) / len(previous) < 0.35
        previous = current


def test_same_seed_writes_the_same_rows(tmp_path: Path) -> None:
    df = _points(2000)
    for name in ("a", "b"):
        write_points_zarr(df, tmp_path / name, feature_key="gene", n_levels=3)
    a = zarr.open_group(tmp_path / "a", mode="r")
    b = zarr.open_group(tmp_path / "b", mode="r")
    for level in ("1", "2"):
        assert np.array_equal(
            _column(a[level]["feature_major"], "id"), _column(b[level]["feature_major"], "id")
        )


def test_refuses_missing_features_and_existing_output(tmp_path: Path) -> None:
    df = _points(100)
    df.loc[0, "gene"] = None
    with pytest.raises(ValueError, match="missing values"):
        write_points_zarr(df, tmp_path / "e", feature_key="gene")
    (tmp_path / "exists").mkdir()
    with pytest.raises(FileExistsError):
        write_points_zarr(_points(100), tmp_path / "exists", feature_key="gene")


def test_store_has_consolidated_metadata(tmp_path: Path) -> None:
    summary = write_points_zarr_store(_points(500), tmp_path / "s.zarr", feature_key="gene")
    root = json.loads((tmp_path / "s.zarr" / "zarr.json").read_text())
    consolidated = root["consolidated_metadata"]["metadata"]
    assert "points/transcripts" in consolidated
    assert consolidated["points/transcripts"]["attributes"]["points:version"] == "0.1"
    assert summary["levels"] == [500]


def test_cli_writes_a_store(tmp_path: Path) -> None:
    source = tmp_path / "points.parquet"
    _points(800).astype({"gene": str}).to_parquet(source)
    out = tmp_path / "out.zarr"
    result = subprocess.run(
        [
            sys.executable,
            "-m",
            "spatialdata_js_util.cli",
            "points",
            "zarr",
            str(source),
            str(out),
            "--feature-key",
            "gene",
            "--levels",
            "2",
        ],
        check=True,
        cwd=Path(__file__).resolve().parents[1],
        capture_output=True,
        text=True,
    )
    summary = json.loads(result.stdout)
    assert summary["levels"][0] == 800
    assert summary["features"] == sorted(GENES)
    assert (out / "points" / "transcripts" / "1" / "feature_major").is_dir()


def test_coordinate_columns_are_written_as_standard_axes(tmp_path: Path) -> None:
    df = _points(300).rename(columns={"x": "x_location", "y": "y_location"})
    write_points_zarr(
        df, tmp_path / "t", feature_key="gene", coordinates=("x_location", "y_location")
    )
    group = zarr.open_group(tmp_path / "t", mode="r")
    assert group.attrs["axes"] == ["x", "y"]
    assert list(group["0"]["tile_major"]["columns"][:]) == ["x", "y", "gene"]
