"""Multiscale pyramid generation for single-resolution rasters."""

from __future__ import annotations

import json
from pathlib import Path

import numpy as np
import pytest

from spatialdata_js_util.errors import WriterCommandError

sd = pytest.importorskip("spatialdata")

from spatialdata_js_util.pyramids import (  # noqa: E402
    MAX_LEVELS,
    add_pyramids,
    has_pyramid,
    resolve_scale_factors,
)


def _image(height: int = 2048, width: int = 1536) -> np.ndarray:
    y, x = np.mgrid[0:height, 0:width]
    return np.stack([((x * 3 + y * 7) % 4096).astype(np.uint16)])


def _labels(height: int = 2048, width: int = 1536) -> np.ndarray:
    y, x = np.mgrid[0:height, 0:width]
    return ((((x // 256) + (y // 256)) % 7) * 13 + 1).astype(np.uint32)


def _store(
    path: Path, *, pixels: np.ndarray | None = None, labels: np.ndarray | None = None, **kwargs
) -> Path:
    from spatialdata.models import Image2DModel, Labels2DModel

    images = {"morphology": Image2DModel.parse(
        _image() if pixels is None else pixels, dims=("c", "y", "x"), **kwargs
    )}
    label_elements = (
        {"cells": Labels2DModel.parse(labels, dims=("y", "x"), **kwargs)}
        if labels is not None
        else {}
    )
    sd.SpatialData(images=images, labels=label_elements).write(path, overwrite=True)
    return path


def _levels(store: Path, collection: str, key: str) -> list[str]:
    attrs = json.loads((store / collection / key / "zarr.json").read_text())["attributes"]
    ome = attrs.get("ome", attrs)
    return [d["path"] for d in ome["multiscales"][0]["datasets"]]


class TestResolveScaleFactors:
    class _Element:
        def __init__(self, **sizes: int) -> None:
            self.sizes = sizes

    def test_auto_halves_until_within_min_size(self) -> None:
        element = self._Element(c=1, y=4096, x=4096)
        assert resolve_scale_factors(element, min_size=1024) == [2, 2]

    def test_auto_returns_nothing_when_already_small(self) -> None:
        element = self._Element(c=1, y=512, x=512)
        assert resolve_scale_factors(element, min_size=1024) == []

    def test_auto_uses_the_largest_spatial_axis(self) -> None:
        element = self._Element(c=1, y=256, x=4096)
        assert resolve_scale_factors(element, min_size=1024) == [2, 2]

    def test_auto_accounts_for_z(self) -> None:
        element = self._Element(c=1, z=8, y=2048, x=2048)
        assert resolve_scale_factors(element, min_size=1024) == [2]

    def test_explicit_levels_counts_full_resolution(self) -> None:
        element = self._Element(c=1, y=4096, x=4096)
        assert resolve_scale_factors(element, levels=3) == [2, 2]
        assert resolve_scale_factors(element, levels=1) == []

    def test_downscale_is_respected(self) -> None:
        element = self._Element(c=1, y=4096, x=4096)
        assert resolve_scale_factors(element, downscale=4, min_size=1024) == [4]

    def test_auto_is_bounded(self) -> None:
        element = self._Element(c=1, y=2**24, x=2**24)
        assert len(resolve_scale_factors(element, min_size=1)) <= MAX_LEVELS - 1

    def test_rejects_a_degenerate_downscale(self) -> None:
        element = self._Element(c=1, y=4096, x=4096)
        with pytest.raises(WriterCommandError, match="at least 2"):
            resolve_scale_factors(element, downscale=1)

    def test_rejects_zero_levels(self) -> None:
        element = self._Element(c=1, y=4096, x=4096)
        with pytest.raises(WriterCommandError, match="at least 1"):
            resolve_scale_factors(element, levels=0)


class TestAddPyramids:
    def test_single_level_store_gains_levels(self, tmp_path: Path) -> None:
        source = _store(tmp_path / "src.zarr")
        assert not has_pyramid(source, "images", "morphology")

        result = add_pyramids(source, tmp_path / "out.zarr")

        dest = result.store_path
        assert has_pyramid(dest, "images", "morphology")
        assert _levels(dest, "images", "morphology") == ["s0", "s1"]

    def test_full_resolution_is_untouched(self, tmp_path: Path) -> None:
        pixels = _image()
        source = _store(tmp_path / "src.zarr", pixels=pixels)

        add_pyramids(source, tmp_path / "out.zarr")

        image = sd.read_zarr(tmp_path / "out.zarr").images["morphology"]
        assert np.array_equal(np.asarray(image["scale0"]["image"].data.compute()), pixels)

    def test_downsampled_level_is_an_average(self, tmp_path: Path) -> None:
        pixels = _image(1024, 1024)
        source = _store(tmp_path / "src.zarr", pixels=pixels)

        add_pyramids(source, tmp_path / "out.zarr", levels=2)

        image = sd.read_zarr(tmp_path / "out.zarr").images["morphology"]
        s1 = np.asarray(image["scale1"]["image"].data.compute())
        expected = pixels.reshape(1, 512, 2, 512, 2).mean(axis=(2, 4)).astype(np.uint16)
        assert np.array_equal(s1, expected)

    def test_transformations_survive(self, tmp_path: Path) -> None:
        from spatialdata.transformations import Scale, get_transformation

        source = _store(tmp_path / "src.zarr", transformations={"global": Scale([2.0, 2.0], axes=("y", "x"))})
        before = get_transformation(sd.read_zarr(source).images["morphology"], get_all=True)

        add_pyramids(source, tmp_path / "out.zarr")

        after = get_transformation(sd.read_zarr(tmp_path / "out.zarr").images["morphology"], get_all=True)
        assert after == before

    def test_already_multiscale_is_skipped(self, tmp_path: Path) -> None:
        source = _store(tmp_path / "src.zarr", scale_factors=[2])
        assert has_pyramid(source, "images", "morphology")

        result = add_pyramids(source, tmp_path / "out.zarr")

        entry = result.manifest["rasters"][0]
        assert entry["action"] == "skipped"
        assert entry["reason"] == "already multiscale"

    def test_force_rebuilds_an_existing_pyramid(self, tmp_path: Path) -> None:
        source = _store(tmp_path / "src.zarr", scale_factors=[2])

        result = add_pyramids(source, tmp_path / "out.zarr", levels=3, force=True)

        assert result.manifest["rasters"][0]["action"] == "rebuilt"
        assert _levels(tmp_path / "out.zarr", "images", "morphology") == ["s0", "s1", "s2"]

    def test_small_image_is_skipped_not_rebuilt(self, tmp_path: Path) -> None:
        source = _store(tmp_path / "src.zarr", pixels=_image(256, 256))

        result = add_pyramids(source, tmp_path / "out.zarr")

        assert result.manifest["rasters"][0]["action"] == "skipped"
        assert not has_pyramid(tmp_path / "out.zarr", "images", "morphology")

    def test_labels_are_left_alone_by_default(self, tmp_path: Path) -> None:
        source = _store(tmp_path / "src.zarr", labels=_labels())

        add_pyramids(source, tmp_path / "out.zarr")

        assert not has_pyramid(tmp_path / "out.zarr", "labels", "cells")

    def test_labels_downsample_without_inventing_ids(self, tmp_path: Path) -> None:
        labels = _labels()
        source = _store(tmp_path / "src.zarr", labels=labels)

        add_pyramids(source, tmp_path / "out.zarr", include_labels=True)

        element = sd.read_zarr(tmp_path / "out.zarr").labels["cells"]
        original = set(np.unique(labels).tolist())
        coarse = set(np.unique(np.asarray(element["scale1"]["image"].data.compute())).tolist())
        # Averaging label ids would produce values that identify no object.
        assert coarse <= original

    def test_other_elements_are_preserved(self, tmp_path: Path) -> None:
        source = _store(tmp_path / "src.zarr", labels=_labels())

        add_pyramids(source, tmp_path / "out.zarr")

        assert (tmp_path / "out.zarr" / "labels" / "cells").is_dir()

    def test_manifest_is_written(self, tmp_path: Path) -> None:
        source = _store(tmp_path / "src.zarr")
        result = add_pyramids(source, tmp_path / "out.zarr")
        assert result.manifest_path is not None and result.manifest_path.is_file()
        assert result.manifest["format"] == "spatialdata-pyramids/v1"

    def test_refuses_to_write_over_the_source(self, tmp_path: Path) -> None:
        source = _store(tmp_path / "src.zarr")
        with pytest.raises(WriterCommandError, match="different store"):
            add_pyramids(source, source, overwrite=True)

    def test_rejects_existing_dest_without_overwrite(self, tmp_path: Path) -> None:
        source = _store(tmp_path / "src.zarr")
        (tmp_path / "out.zarr").mkdir()
        with pytest.raises(WriterCommandError, match="already exists"):
            add_pyramids(source, tmp_path / "out.zarr")

    def test_rejects_unknown_image_key(self, tmp_path: Path) -> None:
        source = _store(tmp_path / "src.zarr")
        with pytest.raises(WriterCommandError, match="Unknown images element"):
            add_pyramids(source, tmp_path / "out.zarr", image_keys=["nope"])

    def test_rejects_a_non_store_path(self, tmp_path: Path) -> None:
        with pytest.raises(WriterCommandError, match="Not a zarr store"):
            add_pyramids(tmp_path, tmp_path / "out.zarr")


class TestRecompressWithPyramid:
    """The one-pass path: single-resolution input to browser-ready output."""

    def test_builds_levels_and_encodes_every_one(self, tmp_path: Path) -> None:
        from spatialdata_js_util import recompress_spatialdata
        from spatialdata_js_util.codecs import CODEC_HTJ2K_OPENJPH, htj2k_available

        if not htj2k_available():
            pytest.skip("No HTJ2K backend available.")

        pixels = _image()
        source = _store(tmp_path / "src.zarr", pixels=pixels)
        dest = tmp_path / "out.zarr"

        result = recompress_spatialdata(
            source,
            dest,
            codec=CODEC_HTJ2K_OPENJPH,
            preset="lossless",
            chunks="auto",
            pyramid=True,
            overwrite=True,
        )

        assert [r["path"] for r in result.manifest["images"]] == [
            "images/morphology/s0",
            "images/morphology/s1",
        ]
        assert result.manifest["pyramids"][0]["action"] == "rebuilt"

        # Both levels must be readable, and full res still exact.
        image = sd.read_zarr(dest).images["morphology"]
        assert np.array_equal(np.asarray(image["scale0"]["image"].data.compute()), pixels)
        assert tuple(image["scale1"]["image"].shape) == (1, 1024, 768)

    def test_without_the_flag_nothing_is_rebuilt(self, tmp_path: Path) -> None:
        from spatialdata_js_util import recompress_spatialdata

        source = _store(tmp_path / "src.zarr")
        result = recompress_spatialdata(
            source, tmp_path / "out.zarr", preset="lossless", chunks="auto", overwrite=True
        )
        assert result.manifest["pyramids"] == []
        assert not has_pyramid(tmp_path / "out.zarr", "images", "morphology")
