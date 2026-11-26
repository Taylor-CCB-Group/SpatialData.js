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

from spatialdata_js_util import (
    add_points_zarr_to_store,
    write_points_zarr,
    write_points_zarr_store,
)
from spatialdata_js_util.points_zarr import SIDECAR_GROUP

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


def _frames(df: pd.DataFrame, n: int):
    """A re-iterable source yielding ``df`` in ``n`` slices, as a converter would."""
    bounds = np.linspace(0, len(df), n + 1).astype(int)
    return lambda: (df.iloc[lo:hi] for lo, hi in zip(bounds[:-1], bounds[1:]))


@pytest.fixture(params=["whole", "out-of-core"])
def element(request: pytest.FixtureRequest, tmp_path: Path) -> tuple[zarr.Group, pd.DataFrame]:
    """The same points written whole, and as 7 frames with a band budget so small that
    every level-0 tile row is its own band and coarser levels sort groups of bands."""
    df = _points()
    data = df if request.param == "whole" else _frames(df, 7)
    write_points_zarr(
        data,
        tmp_path / "transcripts",
        feature_key="gene",
        coordinates=("x", "y", "z"),
        n_levels=3,
        chunk_rows=256,
        shard_chunks=4,
        band_points=1 if request.param == "out-of-core" else 50_000_000,
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


def test_store_keeps_the_standard_element_and_the_copy_beside_it(tmp_path: Path) -> None:
    summary = write_points_zarr_store(_points(500), tmp_path / "s.zarr", feature_key="gene")
    root = json.loads((tmp_path / "s.zarr" / "zarr.json").read_text())
    consolidated = root["consolidated_metadata"]["metadata"]
    element = consolidated["points/transcripts"]["attributes"]
    assert element["spatialdata_attrs"] == {"feature_key": "gene", "version": "0.2"}
    assert "points:version" not in element
    copy = consolidated[f"points/transcripts/{SIDECAR_GROUP}"]["attributes"]
    assert copy["points:version"] == "0.1"
    assert (tmp_path / "s.zarr" / "points" / "transcripts" / "points.parquet" / "part.0.parquet").is_file()
    assert summary["levels"] == [500]


def test_plain_spatialdata_reads_stores_with_a_copy(tmp_path: Path) -> None:
    """ADR 0006: a draft copy beside the standard element must not stop a standard
    reader. Here spatialdata itself, which knows nothing of points-zarr."""
    sd = pytest.importorskip("spatialdata")
    df = _points(700)
    store = tmp_path / "s.zarr"
    write_points_zarr_store(df, store, feature_key="gene", coordinates=("x", "y", "z"))
    points = sd.read_zarr(store)["transcripts"].compute()
    assert len(points) == len(df)
    assert sorted(points["gene"].unique()) == sorted(GENES)
    assert np.allclose(sorted(points["x"]), sorted(df["x"].astype(np.float32)))

    # Rewriting the copy, from the element's own parquet, keeps the store readable.
    add_points_zarr_to_store(None, store, points_key="transcripts", n_levels=2, overwrite=True)
    assert len(sd.read_zarr(store)["transcripts"].compute()) == len(df)


def test_cli_writes_a_store_and_adds_a_copy(tmp_path: Path) -> None:
    source = tmp_path / "points.parquet"
    _points(800).astype({"gene": str}).to_parquet(source)
    out = tmp_path / "out.zarr"

    def cli(*args: str) -> dict:
        result = subprocess.run(
            [sys.executable, "-m", "spatialdata_js_util.cli", "points", *args],
            check=True,
            cwd=Path(__file__).resolve().parents[1],
            capture_output=True,
            text=True,
        )
        return json.loads(result.stdout)

    summary = cli("zarr", str(source), str(out), "--feature-key", "gene", "--levels", "2")
    assert summary["levels"][0] == 800
    assert summary["features"] == sorted(GENES)
    copy = out / "points" / "transcripts" / SIDECAR_GROUP
    assert (copy / "1" / "feature_major").is_dir()

    summary = cli("add-zarr", str(out), "--points-key", "transcripts", "--levels", "3", "--overwrite")
    assert len(summary["levels"]) == 3
    assert (copy / "2" / "feature_major").is_dir()


def test_coordinate_columns_are_written_as_standard_axes(tmp_path: Path) -> None:
    df = _points(300).rename(columns={"x": "x_location", "y": "y_location"})
    write_points_zarr(
        df, tmp_path / "t", feature_key="gene", coordinates=("x_location", "y_location")
    )
    group = zarr.open_group(tmp_path / "t", mode="r")
    assert group.attrs["axes"] == ["x", "y"]
    assert list(group["0"]["tile_major"]["columns"][:]) == ["x", "y", "gene"]


def test_adding_a_copy_merges_only_its_own_metadata(tmp_path: Path) -> None:
    store = tmp_path / "s.zarr"
    write_points_zarr_store(_points(400), store, points_key="a", feature_key="gene", n_levels=2)
    prefix = f"points/a/{SIDECAR_GROUP}"
    before = json.loads((store / "zarr.json").read_text())["consolidated_metadata"]["metadata"]
    outside = {k: v for k, v in before.items() if not k.startswith(prefix)}

    # From the element's own parquet, with its own transforms.
    add_points_zarr_to_store(None, store, points_key="a", n_levels=3, overwrite=True)
    after = json.loads((store / "zarr.json").read_text())["consolidated_metadata"]["metadata"]
    assert {k: v for k, v in after.items() if not k.startswith(prefix)} == outside
    assert f"{prefix}/2/feature_major/column_0" in after
    assert (
        after[prefix]["attributes"]["coordinateTransformations"]
        == after["points/a"]["attributes"]["coordinateTransformations"]
    )

    # Rewritten with fewer levels: the dropped levels' entries go too.
    add_points_zarr_to_store(None, store, points_key="a", n_levels=1, overwrite=True)
    after = json.loads((store / "zarr.json").read_text())["consolidated_metadata"]["metadata"]
    assert not any(k.startswith(f"{prefix}/1") for k in after)


def test_adding_a_copy_needs_a_standard_element(tmp_path: Path) -> None:
    store = tmp_path / "s.zarr"
    write_points_zarr_store(_points(200), store, feature_key="gene")
    with pytest.raises(FileNotFoundError):
        add_points_zarr_to_store(None, store, points_key="missing")
    # merfisheyes' own layout: the element is the points-zarr group, with no parquet.
    write_points_zarr(_points(200), store / "points" / "theirs", feature_key="gene")
    with pytest.raises(ValueError, match="itself a points-zarr element"):
        add_points_zarr_to_store(None, store, points_key="theirs")


def test_small_band_budget_sorts_one_tile_row_at_a_time(tmp_path: Path) -> None:
    messages: list[str] = []
    write_points_zarr(
        _frames(_points(), 3),
        tmp_path / "t",
        feature_key="gene",
        n_levels=3,
        band_points=1,
        progress=messages.append,
    )
    # 600 units of y in 100-unit tiles: 6 level-0 rows, each its own band; a level-2
    # row is 4 of them, so level 2 sorts 2 groups.
    assert "spilling 6,000 points into 6 bands" in messages
    assert any(m.startswith("level 2:") and m.endswith("2 groups") for m in messages)
    assert not any(p.name.startswith(".t-") for p in tmp_path.iterdir())


def test_a_failed_overwrite_keeps_the_existing_copy(tmp_path: Path) -> None:
    store = tmp_path / "s.zarr"
    write_points_zarr_store(_points(300), store, feature_key="gene", n_levels=2)
    copy = store / "points" / "transcripts" / SIDECAR_GROUP
    before = (copy / "zarr.json").read_text()
    # Input without the feature column fails the survey, before anything is replaced.
    with pytest.raises(ValueError, match="Missing columns"):
        add_points_zarr_to_store(
            _points(300).drop(columns=["gene"]),
            store,
            points_key="transcripts",
            feature_key="gene",
            overwrite=True,
        )
    assert (copy / "zarr.json").read_text() == before
    assert (copy / "1" / "feature_major").is_dir()


def test_adding_a_copy_needs_a_feature_key(tmp_path: Path) -> None:
    store = tmp_path / "s.zarr"
    write_points_zarr_store(_points(200), store, feature_key="gene")
    element_json = store / "points" / "transcripts" / "zarr.json"
    meta = json.loads(element_json.read_text())
    del meta["attributes"]["spatialdata_attrs"]["feature_key"]
    element_json.write_text(json.dumps(meta))
    with pytest.raises(ValueError, match="declares no feature_key"):
        add_points_zarr_to_store(None, store, points_key="transcripts", overwrite=True)


def test_cli_add_zarr_refuses_an_existing_copy_without_overwrite(tmp_path: Path) -> None:
    store = tmp_path / "s.zarr"
    write_points_zarr_store(_points(200), store, feature_key="gene")
    result = subprocess.run(
        [sys.executable, "-m", "spatialdata_js_util.cli", "points", "add-zarr", str(store), "--points-key", "transcripts"],
        check=False,
        cwd=Path(__file__).resolve().parents[1],
        capture_output=True,
        text=True,
    )
    assert result.returncode != 0
    assert "Output already exists" in result.stderr
    assert "Traceback" not in result.stderr


def test_standard_parquet_keeps_every_feature_value_across_parts(tmp_path: Path) -> None:
    # Frames whose own index restarts at 0, as Parquet batches do: the written parts
    # must not align the feature column against a continuing index.
    df = _points(900)
    frames = [df.iloc[i : i + 300].reset_index(drop=True) for i in range(0, 900, 300)]
    store = tmp_path / "s.zarr"
    write_points_zarr_store(lambda: iter(frames), store, feature_key="gene")
    parts = sorted((store / "points" / "transcripts" / "points.parquet").glob("part.*.parquet"))
    assert len(parts) == 3
    written = pd.concat([pd.read_parquet(p) for p in parts])
    assert written["gene"].isna().sum() == 0
    assert list(written["gene"].astype(str)) == list(df["gene"].astype(str))
    assert list(written.index) == list(range(900))


def _skewed(seed: int = 4) -> pd.DataFrame:
    """One common gene and one rare gene, with transcript ids."""
    rng = np.random.default_rng(seed)
    counts = {"Common": 20_000, "Middling": 2_000, "Rare": 60}
    gene = np.repeat(list(counts), list(counts.values()))
    n = len(gene)
    return pd.DataFrame(
        {
            "x": rng.uniform(0, 1000, n),
            "y": rng.uniform(0, 600, n),
            "gene": pd.Categorical(gene, categories=list(counts)),
            "tid": rng.permutation(n).astype(np.uint64),
        }
    ).sample(frac=1, random_state=seed).reset_index(drop=True)


def _per_feature_counts(group: zarr.Group, n_features: int) -> list[np.ndarray]:
    return [
        np.bincount(_column(group[e["asset"]]["feature_major"], "gene").astype(np.int64), minlength=n_features)
        for e in group.attrs["multiscales"]["layout"]
    ]


def test_global_sampling_writes_no_fractions(tmp_path: Path) -> None:
    write_points_zarr(_points(2000), tmp_path / "g", feature_key="gene", n_levels=2)
    group = zarr.open_group(tmp_path / "g", mode="r")
    assert "feature_fraction" not in group["1"]["index"]
    assert group.attrs["multiscales"]["layout"][1]["resampling_method"] == "random"
    assert "points:sampling" not in group.attrs


@pytest.mark.parametrize("sampling", ["hybrid", "per-feature"])
def test_per_feature_sampling_keeps_rare_features_and_records_fractions(
    tmp_path: Path, sampling: str
) -> None:
    df = _skewed()
    write_points_zarr(
        df, tmp_path / "t", feature_key="gene", sampling=sampling, feature_budget=100, n_levels=4
    )
    group = zarr.open_group(tmp_path / "t", mode="r")
    layout = group.attrs["multiscales"]["layout"]
    totals = np.bincount(df["gene"].cat.codes)
    per_level = _per_feature_counts(group, 3)
    assert np.array_equal(per_level[0], totals)
    assert group.attrs["points:sampling"] == {"mode": sampling, "feature_budget": 100}

    previous: set[int] | None = None
    for k, entry in enumerate(layout):
        if k:
            assert entry["resampling_method"] == "random-per-feature"
        fractions = group[entry["asset"]]["index"]["feature_fraction"][:]
        assert fractions.dtype == np.float32 and fractions.shape == (3,)
        # The recorded fraction is the inclusion probability: counts sit within noise of it.
        expected = totals * fractions.astype(np.float64)
        sd = np.sqrt(totals * fractions * (1 - fractions.astype(np.float64)))
        assert np.all(np.abs(per_level[k] - expected) <= 5 * sd + 1e-9)
        ids = set(_column(group[entry["asset"]]["feature_major"], "id").astype(np.int64).tolist())
        if previous is not None:
            assert ids <= previous
        previous = ids

    # The rare gene is whole at every level here; the common one is thinned.
    assert all(c[2] == 60 for c in per_level)
    assert per_level[-1][0] < totals[0] / 4
    if sampling == "hybrid":
        # Never thinner than the global quarter-per-level sample.
        assert all(per_level[k][0] >= totals[0] * 4.0**-k * 0.9 for k in range(4))


def test_per_feature_levels_follow_the_counts(tmp_path: Path) -> None:
    df = _skewed()
    # No explicit n_levels: enough that the commonest feature is thinned to its budget.
    summary = write_points_zarr(
        df, tmp_path / "t", feature_key="gene", sampling="per-feature", feature_budget=100
    )
    assert len(summary["levels"]) == 1 + int(np.ceil(np.log(20_000 / 100) / np.log(4)))
    assert summary["levels"] == sorted(summary["levels"], reverse=True)


def test_per_feature_sampling_is_validated(tmp_path: Path) -> None:
    with pytest.raises(ValueError, match="sampling must be"):
        write_points_zarr(_points(100), tmp_path / "a", feature_key="gene", sampling="nope")  # type: ignore[arg-type]
    with pytest.raises(ValueError, match="feature_budget"):
        write_points_zarr(
            _points(100), tmp_path / "b", feature_key="gene", sampling="hybrid", feature_budget=0
        )


def _level_ids(path: Path) -> list[bytes]:
    group = zarr.open_group(path, mode="r")
    return [
        _column(group[e["asset"]]["feature_major"], "id").tobytes()
        for e in group.attrs["multiscales"]["layout"]
    ]


@pytest.mark.parametrize("options", [{"id_key": "tid"}, {"hash_r": True}])
def test_hashed_draws_do_not_depend_on_frame_chunking(tmp_path: Path, options: dict) -> None:
    df = _skewed()
    for name, data in (("one", df), ("many", _frames(df, 7))):
        write_points_zarr(
            data, tmp_path / name, feature_key="gene", n_levels=3, band_points=1 if name == "many" else 50_000_000, **options
        )
    assert _level_ids(tmp_path / "one") == _level_ids(tmp_path / "many")


def test_id_key_ties_the_sample_to_the_transcripts_not_their_order(tmp_path: Path) -> None:
    df = _skewed()
    shuffled = df.sample(frac=1, random_state=9).reset_index(drop=True)

    def sampled(frame: pd.DataFrame, name: str) -> list[set[int]]:
        write_points_zarr(frame, tmp_path / name, feature_key="gene", n_levels=3, id_key="tid")
        group = zarr.open_group(tmp_path / name, mode="r")
        tm = group["0"]["tile_major"]
        # Level-0 rows back to transcript ids, through the (unique) coordinates.
        by_xy = {(np.float32(x), np.float32(y)): t for x, y, t in zip(frame["x"], frame["y"], frame["tid"])}
        row_tid = np.array([by_xy[(x, y)] for x, y in zip(_column(tm, "x"), _column(tm, "y"))])
        return [
            set(row_tid[_column(group[e["asset"]]["feature_major"], "id").astype(np.int64)].tolist())
            for e in group.attrs["multiscales"]["layout"][1:]
        ]

    assert sampled(df, "a") == sampled(shuffled, "b")


def test_hashed_draws_are_uniform(tmp_path: Path) -> None:
    from spatialdata_js_util.points_zarr import _hashed_r

    r = _hashed_r(np.arange(200_000, dtype=np.uint64), seed=0)
    assert r.dtype == np.float32 and r.min() >= 0 and r.max() < 1
    assert abs(float(r.mean()) - 0.5) < 0.005
    assert abs(float((r < 0.25).mean()) - 0.25) < 0.005
    assert not np.array_equal(r, _hashed_r(np.arange(200_000, dtype=np.uint64), seed=1))
