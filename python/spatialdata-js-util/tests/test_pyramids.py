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
    add_pyramids_in_place,
    ensure_pyramids,
    has_pyramid,
    needs_pyramid,
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


def _datasets(store: Path, collection: str, key: str) -> list[dict]:
    attrs = json.loads((store / collection / key / "zarr.json").read_text())["attributes"]
    ome = attrs.get("ome", attrs)
    return ome["multiscales"][0]["datasets"]


def _levels(store: Path, collection: str, key: str) -> list[str]:
    return [d["path"] for d in _datasets(store, collection, key)]


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

    def test_auto_stops_before_an_axis_reaches_zero(self) -> None:
        element = self._Element(c=1, y=2, x=8192)
        assert resolve_scale_factors(element, min_size=1024) == [2]

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

    def test_rejects_more_levels_than_the_cap(self) -> None:
        # Clamping instead would build a different pyramid from the one asked
        # for and report success.
        element = self._Element(c=1, y=4096, x=4096)
        with pytest.raises(WriterCommandError, match="at most"):
            resolve_scale_factors(element, levels=MAX_LEVELS + 1)


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

    def test_adequate_pyramid_is_skipped(self, tmp_path: Path) -> None:
        # 2048 -> 1024: the coarsest level is already within the default min size.
        source = _store(tmp_path / "src.zarr", scale_factors=[2])
        assert has_pyramid(source, "images", "morphology")

        result = add_pyramids(source, tmp_path / "out.zarr")

        entry = result.manifest["rasters"][0]
        assert entry["action"] == "skipped"
        assert entry["reason"] == "coarsest level within min size"
        assert entry["levels"] == ["s0", "s1"]

    def test_shallow_pyramid_is_extended(self, tmp_path: Path) -> None:
        # 2048 -> 1024 is too shallow once the target is 512.
        source = _store(tmp_path / "src.zarr", scale_factors=[2])

        result = add_pyramids(source, tmp_path / "out.zarr", min_size=512)

        entry = result.manifest["rasters"][0]
        assert entry["action"] == "extended"
        assert entry["scale_factors"] == [2]
        assert _levels(tmp_path / "out.zarr", "images", "morphology") == ["s0", "s1", "s2"]

    def test_explicit_levels_skip_a_pyramid_that_has_them(self, tmp_path: Path) -> None:
        source = _store(tmp_path / "src.zarr", scale_factors=[2])

        result = add_pyramids(source, tmp_path / "out.zarr", levels=2)

        entry = result.manifest["rasters"][0]
        assert entry["action"] == "skipped"
        assert entry["reason"] == "already has 2 levels"

    def test_explicit_levels_extend_a_shorter_pyramid(self, tmp_path: Path) -> None:
        source = _store(tmp_path / "src.zarr", scale_factors=[2])

        result = add_pyramids(source, tmp_path / "out.zarr", levels=3)

        assert result.manifest["rasters"][0]["action"] == "extended"
        assert _levels(tmp_path / "out.zarr", "images", "morphology") == ["s0", "s1", "s2"]

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


class TestNeedsPyramid:
    def test_single_level_above_min_size(self) -> None:
        from spatialdata.models import Image2DModel

        element = Image2DModel.parse(_image(), dims=("c", "y", "x"))
        assert needs_pyramid(element)
        assert not needs_pyramid(element, min_size=2048)

    def test_judges_the_coarsest_level(self) -> None:
        from spatialdata.models import Image2DModel

        element = Image2DModel.parse(_image(), dims=("c", "y", "x"), scale_factors=[2])
        assert not needs_pyramid(element)
        assert needs_pyramid(element, min_size=512)


class TestEnsurePyramids:
    """The in-memory path: elements are replaced on the object, nothing is written."""

    def test_single_level_element_gains_levels(self, tmp_path: Path) -> None:
        sdata = sd.read_zarr(_store(tmp_path / "src.zarr"))

        reports = ensure_pyramids(sdata)

        assert reports == [
            {
                "path": "images/morphology",
                "action": "extended",
                "shape": [1, 2048, 1536],
                "scale_factors": [2],
                "level_count": 2,
            }
        ]
        sdata.write(tmp_path / "out.zarr")
        assert _levels(tmp_path / "out.zarr", "images", "morphology") == ["s0", "s1"]

    def test_full_resolution_is_untouched(self, tmp_path: Path) -> None:
        pixels = _image()
        sdata = sd.read_zarr(_store(tmp_path / "src.zarr", pixels=pixels))

        ensure_pyramids(sdata)

        s0 = sdata.images["morphology"]["scale0"]["image"].data.compute()
        assert np.array_equal(np.asarray(s0), pixels)

    def test_shallow_pyramid_is_extended(self, tmp_path: Path) -> None:
        sdata = sd.read_zarr(_store(tmp_path / "src.zarr", scale_factors=[2]))
        before = sdata.images["morphology"]
        existing = [before[name]["image"].data.name for name in ("scale0", "scale1")]

        [report] = ensure_pyramids(sdata, min_size=512)

        assert report["action"] == "extended"
        assert report["scale_factors"] == [2]
        assert report["level_count"] == 3
        # The existing levels are reused, not recomputed from full resolution.
        after = sdata.images["morphology"]
        assert [after[name]["image"].data.name for name in ("scale0", "scale1")] == existing

    def test_new_level_averages_the_coarsest_level(self, tmp_path: Path) -> None:
        sdata = sd.read_zarr(_store(tmp_path / "src.zarr", scale_factors=[2]))
        s1 = np.asarray(sdata.images["morphology"]["scale1"]["image"].data.compute())

        ensure_pyramids(sdata, min_size=512)

        s2 = np.asarray(sdata.images["morphology"]["scale2"]["image"].data.compute())
        expected = s1.reshape(1, 512, 2, 384, 2).mean(axis=(2, 4)).astype(np.uint16)
        assert np.array_equal(s2, expected)

    def test_new_level_coords_are_in_full_resolution_pixels(self, tmp_path: Path) -> None:
        sdata = sd.read_zarr(_store(tmp_path / "src.zarr", scale_factors=[2]))

        ensure_pyramids(sdata, min_size=512)

        s2 = sdata.images["morphology"]["scale2"]["image"]
        # Each s2 pixel covers 4 full-resolution pixels; its centre is at 2, 6, …
        assert s2.coords["x"].values[:2].tolist() == [2.0, 6.0]

    def test_a_raster_too_thin_to_extend_is_left_alone(self, tmp_path: Path) -> None:
        sdata = sd.read_zarr(
            _store(tmp_path / "src.zarr", pixels=_image(2, 8192), scale_factors=[2])
        )

        [report] = ensure_pyramids(sdata)

        assert report["action"] == "skipped"
        assert report["reason"] == "no further levels possible"

    def test_adequate_pyramid_is_left_alone(self, tmp_path: Path) -> None:
        sdata = sd.read_zarr(_store(tmp_path / "src.zarr", scale_factors=[2]))
        before = sdata.images["morphology"]

        [report] = ensure_pyramids(sdata)

        assert report["action"] == "skipped"
        assert report["reason"] == "coarsest level within min size"
        assert report["level_count"] == 2
        assert sdata.images["morphology"] is before

    def test_small_single_level_element_is_left_alone(self, tmp_path: Path) -> None:
        sdata = sd.read_zarr(_store(tmp_path / "src.zarr", pixels=_image(256, 256)))
        before = sdata.images["morphology"]

        [report] = ensure_pyramids(sdata)

        assert report["action"] == "skipped"
        assert sdata.images["morphology"] is before

    def test_level_transforms_match_the_parser(self, tmp_path: Path) -> None:
        from spatialdata.models import Image2DModel
        from spatialdata.transformations import Scale

        transformations = {"global": Scale([2.0, 2.0], axes=("y", "x"))}
        pixels = _image()
        sdata = sd.read_zarr(
            _store(tmp_path / "src.zarr", pixels=pixels, scale_factors=[2], transformations=transformations)
        )

        ensure_pyramids(sdata, min_size=512)
        sdata.write(tmp_path / "out.zarr")

        # The reference is what the parser writes when asked for this pyramid
        # directly: same per-level scale and half-pixel translation.
        reference = Image2DModel.parse(
            pixels, dims=("c", "y", "x"), scale_factors=[2, 2], transformations=transformations
        )
        sd.SpatialData(images={"morphology": reference}).write(tmp_path / "ref.zarr")
        assert _datasets(tmp_path / "out.zarr", "images", "morphology") == _datasets(
            tmp_path / "ref.zarr", "images", "morphology"
        )

    def test_labels_only_with_include_labels(self, tmp_path: Path) -> None:
        sdata = sd.read_zarr(_store(tmp_path / "src.zarr", labels=_labels()))
        labels_before = sdata.labels["cells"]

        reports = ensure_pyramids(sdata)
        assert [r["path"] for r in reports] == ["images/morphology"]
        assert sdata.labels["cells"] is labels_before

        reports = ensure_pyramids(sdata, include_labels=True)
        [labels_report] = [r for r in reports if r["path"] == "labels/cells"]
        assert labels_report["action"] == "extended"
        coarse = np.asarray(sdata.labels["cells"]["scale1"]["image"].data.compute())
        assert set(np.unique(coarse).tolist()) <= set(np.unique(_labels()).tolist())

    def test_shallow_labels_pyramid_keeps_valid_ids(self, tmp_path: Path) -> None:
        labels = _labels()
        sdata = sd.read_zarr(_store(tmp_path / "src.zarr", labels=labels, scale_factors=[2]))

        reports = ensure_pyramids(sdata, include_labels=True, min_size=512)

        [labels_report] = [r for r in reports if r["path"] == "labels/cells"]
        assert labels_report["action"] == "extended"
        coarse = np.asarray(sdata.labels["cells"]["scale2"]["image"].data.compute())
        assert set(np.unique(coarse).tolist()) <= set(np.unique(labels).tolist())

    def test_keys_limit_the_elements_considered(self, tmp_path: Path) -> None:
        sdata = sd.read_zarr(_store(tmp_path / "src.zarr", labels=_labels()))

        reports = ensure_pyramids(sdata, include_labels=True, image_keys=[])

        assert [r["path"] for r in reports] == ["labels/cells"]

    def test_rejects_unknown_keys(self, tmp_path: Path) -> None:
        sdata = sd.read_zarr(_store(tmp_path / "src.zarr"))
        with pytest.raises(WriterCommandError, match="Unknown images element"):
            ensure_pyramids(sdata, image_keys=["nope"])

    def test_writes_nothing(self, tmp_path: Path) -> None:
        source = _store(tmp_path / "src.zarr")
        before = sorted(p.relative_to(tmp_path) for p in tmp_path.rglob("*"))

        ensure_pyramids(sd.read_zarr(source))

        assert sorted(p.relative_to(tmp_path) for p in tmp_path.rglob("*")) == before


def _snapshot(store: Path) -> dict[str, bytes]:
    return {str(f.relative_to(store)): f.read_bytes() for f in store.rglob("*") if f.is_file()}


class TestAddPyramidsInPlace:
    """Levels are appended to the store itself; what exists is never rewritten."""

    def test_single_level_store_gains_levels(self, tmp_path: Path) -> None:
        store = _store(tmp_path / "s.zarr")

        result = add_pyramids_in_place(store)

        assert result.store_path == store
        assert result.manifest["rasters"][0]["action"] == "extended"
        assert _levels(store, "images", "morphology") == ["s0", "s1"]
        assert not (tmp_path / "s.zarr.tmp").exists()

    def test_existing_arrays_are_byte_identical(self, tmp_path: Path) -> None:
        store = _store(tmp_path / "s.zarr", scale_factors=[2])
        before = _snapshot(store)

        add_pyramids_in_place(store, min_size=512)

        after = _snapshot(store)
        changed = {name for name in before if after.get(name) != before[name]}
        # Only the metadata that declares levels may change.
        assert changed == {"zarr.json", "images/morphology/zarr.json"}
        assert any(name.startswith("images/morphology/s2/") for name in after)

    def test_levels_match_a_fresh_build(self, tmp_path: Path) -> None:
        from spatialdata.models import Image2DModel
        from spatialdata.transformations import Scale

        transformations = {"global": Scale([2.0, 2.0], axes=("y", "x"))}
        pixels = _image()
        store = _store(
            tmp_path / "s.zarr", pixels=pixels, scale_factors=[2], transformations=transformations
        )

        add_pyramids_in_place(store, min_size=512)

        reference = Image2DModel.parse(
            pixels, dims=("c", "y", "x"), scale_factors=[2, 2], transformations=transformations
        )
        sd.SpatialData(images={"morphology": reference}).write(tmp_path / "ref.zarr")
        assert _datasets(store, "images", "morphology") == _datasets(
            tmp_path / "ref.zarr", "images", "morphology"
        )
        ours = sd.read_zarr(store).images["morphology"]["scale2"]["image"].data.compute()
        theirs = sd.read_zarr(tmp_path / "ref.zarr").images["morphology"]["scale2"]["image"].data.compute()
        assert np.array_equal(np.asarray(ours), np.asarray(theirs))

    def test_several_new_levels_match_a_fresh_build(self, tmp_path: Path) -> None:
        from spatialdata.models import Image2DModel

        pixels = _image(4096, 2048)
        store = _store(tmp_path / "s.zarr", pixels=pixels)

        add_pyramids_in_place(store, min_size=512)

        assert _levels(store, "images", "morphology") == ["s0", "s1", "s2", "s3"]
        reference = Image2DModel.parse(pixels, dims=("c", "y", "x"), scale_factors=[2, 2, 2])
        sd.SpatialData(images={"morphology": reference}).write(tmp_path / "ref.zarr")
        ours = sd.read_zarr(store).images["morphology"]
        theirs = sd.read_zarr(tmp_path / "ref.zarr").images["morphology"]
        for level in ("scale1", "scale2", "scale3"):
            assert np.array_equal(
                np.asarray(ours[level]["image"].data.compute()),
                np.asarray(theirs[level]["image"].data.compute()),
            ), level

    def test_store_reads_back_with_consolidated_metadata_current(self, tmp_path: Path) -> None:
        store = _store(tmp_path / "s.zarr")

        add_pyramids_in_place(store)

        root = json.loads((store / "zarr.json").read_text())
        assert "images/morphology/s1" in root["consolidated_metadata"]["metadata"]
        assert list(sd.read_zarr(store).images["morphology"]) == ["scale0", "scale1"]

    def test_adequate_pyramid_leaves_every_file_alone(self, tmp_path: Path) -> None:
        store = _store(tmp_path / "s.zarr", scale_factors=[2])
        before = _snapshot(store)

        result = add_pyramids_in_place(store, manifest=False)

        assert result.manifest["rasters"][0]["action"] == "skipped"
        assert _snapshot(store) == before

    def test_a_second_run_changes_nothing(self, tmp_path: Path) -> None:
        store = _store(tmp_path / "s.zarr")
        add_pyramids_in_place(store, min_size=512)
        before = _snapshot(store)

        result = add_pyramids_in_place(store, min_size=512, manifest=False)

        assert result.manifest["rasters"][0]["action"] == "skipped"
        assert _snapshot(store) == before

    def test_labels_only_with_include_labels(self, tmp_path: Path) -> None:
        store = _store(tmp_path / "s.zarr", labels=_labels())

        add_pyramids_in_place(store)
        assert not has_pyramid(store, "labels", "cells")

        add_pyramids_in_place(store, include_labels=True)
        assert _levels(store, "labels", "cells") == ["s0", "s1"]
        coarse = sd.read_zarr(store).labels["cells"]["scale1"]["image"].data.compute()
        assert set(np.unique(np.asarray(coarse)).tolist()) <= set(np.unique(_labels()).tolist())

    def test_other_elements_are_not_read_or_changed(self, tmp_path: Path) -> None:
        store = _store(tmp_path / "s.zarr", labels=_labels())
        before = _snapshot(store / "labels")

        add_pyramids_in_place(store)

        assert _snapshot(store / "labels") == before

    def test_an_interrupted_run_is_completed_by_the_next(self, tmp_path: Path) -> None:
        import zarr

        store = _store(tmp_path / "s.zarr")
        # What a run that died after writing arrays but before declaring them leaves.
        group = zarr.open_group(store, mode="r+", use_consolidated=False)["images"]["morphology"]
        group.create_array("s1", shape=(1, 7, 7), dtype="uint16", chunks=(1, 7, 7))
        assert _levels(store, "images", "morphology") == ["s0"]

        add_pyramids_in_place(store)

        assert _levels(store, "images", "morphology") == ["s0", "s1"]
        s1 = sd.read_zarr(store).images["morphology"]["scale1"]["image"]
        assert tuple(s1.shape) == (1, 1024, 768)
        assert int(s1.data.compute().max()) > 0

    def test_refuses_levels_whose_transforms_do_not_follow_their_shapes(self, tmp_path: Path) -> None:
        store = _store(tmp_path / "s.zarr", scale_factors=[2])
        meta_path = store / "images" / "morphology" / "zarr.json"
        doc = json.loads(meta_path.read_text())
        ome = doc["attributes"]["ome"]["multiscales"][0]["datasets"][1]
        ome["coordinateTransformations"][1]["translation"] = [0.0, 0.0, 0.0]
        meta_path.write_text(json.dumps(doc))
        before = _snapshot(store)

        with pytest.raises(WriterCommandError, match="do not follow"):
            add_pyramids_in_place(store, min_size=512)

        assert _snapshot(store) == before

    def test_new_levels_copy_the_coarsest_levels_plain_codecs(self, tmp_path: Path) -> None:
        store = _store(tmp_path / "s.zarr")

        add_pyramids_in_place(store)

        def codecs(level: str) -> list:
            meta = json.loads((store / "images" / "morphology" / level / "zarr.json").read_text())
            return meta["codecs"]

        assert codecs("s1") == codecs("s0")

    def test_levels_added_below_an_image_codec_use_plain_codecs(self, tmp_path: Path) -> None:
        from spatialdata_js_util import recompress_spatialdata
        from spatialdata_js_util.codecs import CODEC_HTJ2K_OPENJPH, htj2k_available

        if not htj2k_available():
            pytest.skip("No HTJ2K backend available.")

        source = _store(tmp_path / "src.zarr")
        dest = tmp_path / "htj2k.zarr"
        recompress_spatialdata(
            source, dest, codec=CODEC_HTJ2K_OPENJPH, preset="lossless", chunks="auto", overwrite=True
        )
        s0 = json.loads((dest / "images" / "morphology" / "s0" / "zarr.json").read_text())
        assert "htj2k" in json.dumps(s0["codecs"]).lower()

        add_pyramids_in_place(dest)

        s1 = json.loads((dest / "images" / "morphology" / "s1" / "zarr.json").read_text())
        assert "htj2k" not in json.dumps(s1["codecs"]).lower()
        assert [c["name"] for c in s1["codecs"]] == ["bytes", "zstd"]
        # The encoded level is left exactly as it was.
        assert np.array_equal(
            np.asarray(sd.read_zarr(dest).images["morphology"]["scale0"]["image"].data.compute()),
            _image(),
        )

    def test_rejects_a_non_store_path(self, tmp_path: Path) -> None:
        with pytest.raises(WriterCommandError, match="Not a zarr store"):
            add_pyramids_in_place(tmp_path)

    def test_rejects_unknown_image_key(self, tmp_path: Path) -> None:
        store = _store(tmp_path / "s.zarr")
        with pytest.raises(WriterCommandError, match="Unknown images element"):
            add_pyramids_in_place(store, image_keys=["nope"])


class TestAddPyramidCli:
    def _run(self, *argv: str) -> None:
        from spatialdata_js_util.cli import main

        main(["images", "add-pyramid", *argv])

    def test_in_place_appends_to_the_source(self, tmp_path: Path) -> None:
        store = _store(tmp_path / "s.zarr")

        self._run(str(store), "--in-place")

        assert _levels(store, "images", "morphology") == ["s0", "s1"]

    def test_without_in_place_a_destination_is_required(self, tmp_path: Path) -> None:
        store = _store(tmp_path / "s.zarr")
        with pytest.raises(SystemExit, match="destination"):
            self._run(str(store))

    @pytest.mark.parametrize("extra", [["--overwrite"], ["--pyramid-force"]])
    def test_in_place_rejects_options_that_replace_levels(
        self, tmp_path: Path, extra: list[str]
    ) -> None:
        store = _store(tmp_path / "s.zarr")
        with pytest.raises(SystemExit, match="only adds levels"):
            self._run(str(store), "--in-place", *extra)

    def test_in_place_rejects_a_destination(self, tmp_path: Path) -> None:
        store = _store(tmp_path / "s.zarr")
        with pytest.raises(SystemExit, match="no destination"):
            self._run(str(store), str(tmp_path / "out.zarr"), "--in-place")


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
        assert result.manifest["pyramids"][0]["action"] == "extended"

        # Both levels must be readable, and full res still exact.
        image = sd.read_zarr(dest).images["morphology"]
        assert np.array_equal(np.asarray(image["scale0"]["image"].data.compute()), pixels)
        assert tuple(image["scale1"]["image"].shape) == (1, 1024, 768)

    def test_extends_a_shallow_pyramid_and_encodes_every_level(self, tmp_path: Path) -> None:
        from spatialdata_js_util import recompress_spatialdata

        source = _store(tmp_path / "src.zarr", scale_factors=[2])
        result = recompress_spatialdata(
            source,
            tmp_path / "out.zarr",
            preset="lossless",
            chunks="auto",
            pyramid=True,
            pyramid_min_size=512,
            overwrite=True,
        )

        assert result.manifest["pyramids"][0]["action"] == "extended"
        assert [r["path"] for r in result.manifest["images"]] == [
            "images/morphology/s0",
            "images/morphology/s1",
            "images/morphology/s2",
        ]

    def test_without_the_flag_nothing_is_rebuilt(self, tmp_path: Path) -> None:
        from spatialdata_js_util import recompress_spatialdata

        source = _store(tmp_path / "src.zarr")
        result = recompress_spatialdata(
            source, tmp_path / "out.zarr", preset="lossless", chunks="auto", overwrite=True
        )
        assert result.manifest["pyramids"] == []
        assert not has_pyramid(tmp_path / "out.zarr", "images", "morphology")
