"""Writing a SpatialData to disk: vanishing files, copied points, zip packing."""

from __future__ import annotations

import json
import os
import shutil
import sys
import zipfile
from pathlib import Path

import numpy as np
import pytest

from spatialdata_js_util import (
    CODEC_JPEG2K,
    recompress_spatialdata,
    remove_tree,
    write_spatialdata,
    zip_directory,
)

anndata = pytest.importorskip("anndata")
pd = pytest.importorskip("pandas")
sd = pytest.importorskip("spatialdata")

MARKER = "marker.txt"


def _table(*, nullable: bool = True):
    from spatialdata.models import TableModel

    n_obs = 12
    adata = anndata.AnnData(X=np.ones((n_obs, 3), dtype=np.float32))
    adata.obs["region"] = pd.Categorical(["img"] * n_obs)
    adata.obs["instance_id"] = np.arange(n_obs)
    if nullable:
        # The dtypes 10x Genomics and SpatialData.js stores carry, which plain
        # `SpatialData.write` refuses.
        adata.obs["cell_type"] = pd.array(["a", "b", None] * 4, dtype="string")
        adata.obs_names = pd.Index([f"cell{i}" for i in range(n_obs)], dtype="string")
    return TableModel.parse(adata, region="img", region_key="region", instance_key="instance_id")


def _points():
    from spatialdata.models import PointsModel

    rng = np.random.default_rng(0)
    return PointsModel.parse(
        pd.DataFrame({"x": rng.uniform(0, 8, 200), "y": rng.uniform(0, 8, 200)})
    )


def _image():
    from spatialdata.models import Image2DModel

    data = np.arange(2 * 16 * 16, dtype=np.uint16).reshape(2, 16, 16)
    return Image2DModel.parse(data, dims=("c", "y", "x"), chunks=(1, 8, 8))


def _source_store(path: Path) -> Path:
    """A store on disk whose points carry a marker file a re-encode would not."""
    sd.SpatialData(
        images={"img": _image()},
        points={"transcripts": _points()},
        tables={"table": _table(nullable=False)},
    ).write(path)
    (path / "points" / "transcripts" / MARKER).write_text("copied")
    return path


class TestRemoveTree:
    @pytest.mark.skipif(not shutil._use_fd_functions, reason="needs shutil's fd-based walk")
    def test_survives_a_sibling_vanishing_mid_walk(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """exFAT on macOS deletes `._name` together with `name`, behind rmtree's back."""
        real_unlink = os.unlink

        def unlink_taking_siblings_along(name, *, dir_fd=None):
            real_unlink(name, dir_fd=dir_fd)
            if dir_fd is not None:
                for sibling in os.listdir(dir_fd):
                    real_unlink(sibling, dir_fd=dir_fd)

        def make_tree(path: Path) -> Path:
            path.mkdir()
            for name in ("0", "._0", "1", "._1"):
                (path / name).write_text("x")
            return path

        monkeypatch.setattr(os, "unlink", unlink_taking_siblings_along)
        if sys.version_info < (3, 13):  # 3.13's rmtree tolerates this itself
            with pytest.raises(FileNotFoundError):
                shutil.rmtree(make_tree(tmp_path / "plain"))

        tree = make_tree(tmp_path / "tolerant")
        remove_tree(tree)
        assert not tree.exists()

    def test_missing_path_is_not_an_error(self, tmp_path: Path) -> None:
        remove_tree(tmp_path / "absent")

    def test_real_errors_still_raise(self, tmp_path: Path) -> None:
        file = tmp_path / "file"
        file.write_text("x")
        with pytest.raises(NotADirectoryError):
            remove_tree(file)


class TestWriteSpatialdata:
    def test_unchanged_points_are_copied_as_files(self, tmp_path: Path) -> None:
        source = _source_store(tmp_path / "source.zarr")

        write_spatialdata(sd.read_zarr(source), tmp_path / "out.zarr")

        out = tmp_path / "out.zarr"
        assert (out / "points" / "transcripts" / MARKER).read_text() == "copied"
        assert sd.read_zarr(out).points["transcripts"].compute().shape == (200, 2)
        # The consolidated listing describes the copied element too.
        root = json.loads((out / "zarr.json").read_text())
        assert "points/transcripts" in root["consolidated_metadata"]["metadata"]

    def test_modified_points_are_written(self, tmp_path: Path) -> None:
        source = _source_store(tmp_path / "source.zarr")
        sdata = sd.read_zarr(source)
        sdata.points["transcripts"]["z"] = 1.0

        write_spatialdata(sdata, tmp_path / "out.zarr")

        out = tmp_path / "out.zarr"
        assert not (out / "points" / "transcripts" / MARKER).exists()
        assert "z" in sd.read_zarr(out).points["transcripts"].columns

    def test_writes_nullable_strings(self, tmp_path: Path) -> None:
        sdata = sd.SpatialData(points={"transcripts": _points()}, tables={"table": _table()})

        # anndata < 0.13 defaults to refusing these; make that so on any version.
        with anndata.settings.override(allow_write_nullable_strings=False):
            with pytest.raises(Exception, match="allow_write_nullable_strings"):
                sdata.write(tmp_path / "plain.zarr")
            write_spatialdata(sdata, tmp_path / "out.zarr")

        obs = sd.read_zarr(tmp_path / "out.zarr").tables["table"].obs
        assert list(obs["cell_type"].isna()) == [False, False, True] * 4

    def test_in_memory_sdata_with_no_source_store_writes_normally(self, tmp_path: Path) -> None:
        write_spatialdata(sd.SpatialData(points={"transcripts": _points()}), tmp_path / "out.zarr")

        assert "transcripts" in sd.read_zarr(tmp_path / "out.zarr").points

    def test_refuses_to_replace_without_overwrite(self, tmp_path: Path) -> None:
        sdata = sd.SpatialData(points={"transcripts": _points()})
        (tmp_path / "out.zarr").mkdir()

        with pytest.raises(FileExistsError):
            write_spatialdata(sdata, tmp_path / "out.zarr")

        write_spatialdata(sdata, tmp_path / "out.zarr", overwrite=True)
        assert (tmp_path / "out.zarr" / "points" / "transcripts").is_dir()

    @pytest.mark.parametrize("target", [".", "source.zarr"])
    def test_never_deletes_the_store_it_was_read_from(self, tmp_path: Path, target: str) -> None:
        source = _source_store(tmp_path / "source.zarr")

        with pytest.raises(ValueError, match="backs the SpatialData"):
            write_spatialdata(sd.read_zarr(source), tmp_path / target, overwrite=True)

        assert (source / "points" / "transcripts" / MARKER).exists()

    def test_edited_transformations_are_written_not_copied(self, tmp_path: Path) -> None:
        from spatialdata.transformations import Scale, get_transformation, set_transformation

        source = _source_store(tmp_path / "source.zarr")
        sdata = sd.read_zarr(source)
        scale = Scale([2.0, 2.0], axes=("x", "y"))
        set_transformation(sdata.points["transcripts"], scale, "global")

        write_spatialdata(sdata, tmp_path / "out.zarr")

        written = sd.read_zarr(tmp_path / "out.zarr").points["transcripts"]
        assert get_transformation(written, "global") == scale
        assert not (tmp_path / "out.zarr" / "points" / "transcripts" / MARKER).exists()

    def test_leaves_sdata_pointing_at_the_new_store(self, tmp_path: Path) -> None:
        sdata = sd.read_zarr(_source_store(tmp_path / "source.zarr"))

        write_spatialdata(sdata, tmp_path / "out.zarr")

        assert Path(sdata.path) == tmp_path / "out.zarr"


class TestRecompressInMemory:
    def test_copies_points_and_recompresses_images(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        source = _source_store(tmp_path / "source.zarr")
        sdata = sd.read_zarr(source)
        sdata.tables["table"] = _table()
        scratch = tmp_path / "scratch"
        scratch.mkdir()

        from spatialdata_js_util import images

        mirrors: list[Path] = []
        real_mirror = images._mirror_rasters

        def spy(store, mirror, *args):
            mirrors.append(mirror)
            return real_mirror(store, mirror, *args)

        monkeypatch.setattr(images, "_mirror_rasters", spy)

        with anndata.settings.override(allow_write_nullable_strings=False):
            result = recompress_spatialdata(
                sdata,
                tmp_path / "out.zarr",
                codec=CODEC_JPEG2K,
                preset="lossless",
                chunks=[1, 8, 8],
                manifest=False,
                temp_dir=scratch,
            )

        out = result.store_path
        assert (out / "points" / "transcripts" / MARKER).read_text() == "copied"
        image_meta = json.loads((out / "images" / "img" / "s0" / "zarr.json").read_text())
        assert image_meta["codecs"][0]["name"] == CODEC_JPEG2K
        assert mirrors and mirrors[0].is_relative_to(scratch)
        assert list(scratch.iterdir()) == []
        reread = sd.read_zarr(out)
        assert np.array_equal(np.asarray(reread.images["img"]), np.asarray(_image()))
        assert "cell_type" in reread.tables["table"].obs


    def test_temp_dir_inside_a_path_source_is_refused(self, tmp_path: Path) -> None:
        source = _source_store(tmp_path / "source.zarr")

        with pytest.raises(ValueError, match="temp_dir"):
            recompress_spatialdata(
                source, tmp_path / "out.zarr", pyramid=True, temp_dir=source / "scratch"
            )

    def test_temp_dir_inside_the_destination_is_refused(self, tmp_path: Path) -> None:
        sdata = sd.read_zarr(_source_store(tmp_path / "source.zarr"))
        out = tmp_path / "out.zarr"

        with pytest.raises(ValueError, match="destination"):
            recompress_spatialdata(sdata, out, codec=CODEC_JPEG2K, temp_dir=out / "scratch")

        assert not out.exists()

    def test_pyramids_are_staged_from_the_rasters_alone(self, tmp_path: Path) -> None:
        source = _source_store(tmp_path / "source.zarr")

        result = recompress_spatialdata(
            sd.read_zarr(source),
            tmp_path / "out.zarr",
            codec=CODEC_JPEG2K,
            preset="lossless",
            chunks=[1, 8, 8],
            manifest=False,
            pyramid=True,
            pyramid_min_size=8,
        )

        assert len(result.manifest["pyramids"]) == 1
        assert (result.store_path / "images" / "img" / "s1" / "zarr.json").exists()
        assert (result.store_path / "points" / "transcripts" / MARKER).exists()


class TestZipDirectory:
    def _store(self, root: Path) -> Path:
        (root / "points" / "t").mkdir(parents=True)
        (root / "zarr.json").write_text('{"zarr_format": 3}')
        (root / "points" / "t" / "chunk").write_bytes(b"\x00" * 1000)
        return root

    def test_contents_sit_at_the_archive_root_uncompressed(self, tmp_path: Path) -> None:
        store = self._store(tmp_path / "store.zarr")

        zip_directory(store, tmp_path / "store.zip")

        with zipfile.ZipFile(tmp_path / "store.zip") as archive:
            assert sorted(archive.namelist()) == ["points/t/chunk", "zarr.json"]
            assert {info.compress_type for info in archive.infolist()} == {zipfile.ZIP_STORED}
            assert archive.read("points/t/chunk") == b"\x00" * 1000

    def test_missing_source_is_an_error_not_an_empty_zip(self, tmp_path: Path) -> None:
        with pytest.raises(NotADirectoryError):
            zip_directory(tmp_path / "absent", tmp_path / "x.zip")

        assert not (tmp_path / "x.zip").exists()

    def test_zip_inside_the_source_is_not_packed_into_itself(self, tmp_path: Path) -> None:
        store = self._store(tmp_path / "store.zarr")

        zip_directory(store, store / "store.zip")
        zip_directory(store, store / "store.zip")

        with zipfile.ZipFile(store / "store.zip") as archive:
            assert sorted(archive.namelist()) == ["points/t/chunk", "zarr.json"]

    def test_failure_leaves_no_partial_file(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        store = self._store(tmp_path / "store.zarr")

        def fail(self, *args, **kwargs):
            raise OSError("disk full")

        monkeypatch.setattr(zipfile.ZipFile, "write", fail)
        with pytest.raises(OSError, match="disk full"):
            zip_directory(store, tmp_path / "store.zip")

        assert list(tmp_path.glob("*.zip*")) == []
        assert list(tmp_path.glob(".*partial")) == []

    def test_cli(self, tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
        from spatialdata_js_util.cli import main

        store = self._store(tmp_path / "store.zarr")

        main(["zip", str(store), str(tmp_path / "store.zip")])

        summary = json.loads(capsys.readouterr().out)
        assert summary["bytes"] == (tmp_path / "store.zip").stat().st_size
        with pytest.raises(SystemExit, match="already exists"):
            main(["zip", str(store), str(tmp_path / "store.zip")])
        main(["zip", str(store), str(tmp_path / "store.zip"), "--overwrite"])


def test_replace_keeping_original_restores_a_directory_when_the_move_fails(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    import os

    from spatialdata_js_util.store import replace_keeping_original

    target = tmp_path / "points.parquet"
    target.mkdir()
    (target / "part.0.parquet").write_bytes(b"original")
    staged = tmp_path / ".points.parquet.partial"
    staged.write_bytes(b"sorted")

    def failing_replace(*_args):
        raise OSError("disk full")

    monkeypatch.setattr(os, "replace", failing_replace)
    with pytest.raises(OSError):
        replace_keeping_original(staged, target)
    assert (target / "part.0.parquet").read_bytes() == b"original"

    monkeypatch.undo()
    replace_keeping_original(staged, target)
    assert target.read_bytes() == b"sorted"
    assert sorted(p.name for p in tmp_path.iterdir()) == ["points.parquet"]
