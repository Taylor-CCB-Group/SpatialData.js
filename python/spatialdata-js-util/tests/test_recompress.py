from __future__ import annotations

import json
import warnings
from pathlib import Path

import imagecodecs
import numpy as np
import pytest
import zarr

from spatialdata_js_util import (
    CODEC_HTJ2K_OPENJPH,
    CODEC_JPEG2K,
    HTJ2K_PRESETS,
    HTJ2K_QUALITY_FLOOR_LSB,
    JP2K_PRESETS,
    dtype_quantum,
    htj2k_available,
    htj2k_preset_quality,
    recompress_spatialdata,
    resolve_recompression_config,
)
from spatialdata_js_util.codecs import decode_htj2k_plane, encode_image_plane
from spatialdata_js_util.images import _preset_encode_options

from synthetic_images import mandelbrot_plane


def _write_json(path: Path, value: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, indent=2, sort_keys=True))


def _group_meta(attributes: dict | None = None) -> dict:
    return {"zarr_format": 3, "node_type": "group", "attributes": attributes or {}}


def _raster_attrs(name: str, axes: list[str]) -> dict:
    return {
        "ome": {
            "multiscales": [
                {
                    "name": name,
                    "axes": [{"name": axis} for axis in axes],
                    "datasets": [{"path": "0"}],
                }
            ]
        }
    }


def _write_source_store(root: Path, *, image_dtype: str = "uint16") -> Path:
    _write_json(root / "zarr.json", _group_meta({"spatialdata_attrs": {"version": "0.7.2"}}))
    _write_json(root / "images" / "zarr.json", _group_meta())
    _write_json(
        root / "images" / "morphology" / "zarr.json",
        _group_meta(_raster_attrs("morphology", ["c", "y", "x"])),
    )
    _write_json(root / "labels" / "zarr.json", _group_meta())
    _write_json(
        root / "labels" / "cells" / "zarr.json",
        _group_meta(_raster_attrs("cells", ["y", "x"])),
    )
    _write_json(root / "tables" / "table" / "zarr.json", _group_meta({"kept": True}))

    image = zarr.create_array(
        store=str(root / "images" / "morphology" / "0"),
        shape=(1, 8, 8),
        chunks=(1, 4, 4),
        dtype=image_dtype,
        dimension_names=("c", "y", "x"),
        zarr_format=3,
    )
    image[:] = np.arange(64, dtype=np.dtype(image_dtype)).reshape(1, 8, 8)

    labels = zarr.create_array(
        store=str(root / "labels" / "cells" / "0"),
        shape=(8, 8),
        chunks=(4, 4),
        dtype="uint32",
        dimension_names=("y", "x"),
        zarr_format=3,
    )
    labels[:] = np.arange(64, dtype=np.uint32).reshape(8, 8)
    return root


def test_resolve_recompression_config_applies_cli_shortcuts() -> None:
    config = resolve_recompression_config(
        {"default_image": {"preset": "lossless"}},
        image_key="morphology",
        preset="balanced",
        chunks=(1, 4, 4),
    )

    assert config["images"]["morphology"]["preset"] == "balanced"
    assert config["images"]["morphology"]["chunks"] == (1, 4, 4)
    assert config["default_image"]["preset"] == "lossless"


def test_resolve_recompression_config_applies_codec_shortcut() -> None:
    config = resolve_recompression_config(
        {},
        image_key="morphology",
        codec=CODEC_HTJ2K_OPENJPH,
        preset="lossless",
    )

    assert config["images"]["morphology"]["codec"] == CODEC_HTJ2K_OPENJPH
    assert config["images"]["morphology"]["preset"] == "lossless"
    assert config["default_image"]["codec"] == "imagecodecs_jpeg2k"


def test_resolve_recompression_config_applies_quality_shortcut() -> None:
    config = resolve_recompression_config(
        {},
        image_key="morphology",
        codec=CODEC_HTJ2K_OPENJPH,
        quality=0.001,
    )

    assert config["images"]["morphology"]["quality"] == 0.001
    assert "preset" not in config["images"]["morphology"]


def test_resolve_recompression_config_applies_shortcuts_to_all_images() -> None:
    config = resolve_recompression_config(
        {},
        codec=CODEC_HTJ2K_OPENJPH,
        quality=0.0005,
        chunks="auto",
    )

    assert config["images"] == {}
    assert config["default_image"]["codec"] == CODEC_HTJ2K_OPENJPH
    assert config["default_image"]["quality"] == 0.0005
    assert config["default_image"]["chunks"] == "auto"


def _write_multi_image_store(root: Path) -> Path:
    store = _write_source_store(root)
    _write_json(
        root / "images" / "histology" / "zarr.json",
        _group_meta(_raster_attrs("histology", ["c", "y", "x"])),
    )
    image = zarr.create_array(
        store=str(root / "images" / "histology" / "0"),
        shape=(1, 8, 8),
        chunks=(1, 4, 4),
        dtype="uint16",
        dimension_names=("c", "y", "x"),
        zarr_format=3,
    )
    image[:] = (np.arange(64, dtype=np.uint16) * 2).reshape(1, 8, 8)
    return store


def test_recompress_spatialdata_applies_default_image_to_all_images(tmp_path: Path) -> None:
    source = _write_multi_image_store(tmp_path / "source.zarr")

    result = recompress_spatialdata(
        source,
        tmp_path / "out.zarr",
        preset="lossless",
        chunks=[1, 4, 4],
        config={"default_labels": {"codec": None}},
    )

    assert {report["path"] for report in result.manifest["images"]} == {
        "images/morphology/0",
        "images/histology/0",
    }
    for image_key in ("morphology", "histology"):
        image_meta = json.loads(
            (result.store_path / "images" / image_key / "0" / "zarr.json").read_text()
        )
        assert image_meta["codecs"] == [{"name": "imagecodecs_jpeg2k", "configuration": {}}]


@pytest.mark.skipif(
    not htj2k_available(),
    reason="No HTJ2K encoder is available in this environment.",
)
def test_recompress_sibling_applies_to_all_images(tmp_path: Path) -> None:
    source = _write_multi_image_store(tmp_path / "source.zarr")

    result = recompress_spatialdata(
        source,
        tmp_path / "out.zarr",
        codec=CODEC_HTJ2K_OPENJPH,
        quality=0.0005,
        chunks=[1, 4, 4],
        config={"default_labels": {"codec": None}},
        sibling=True,
    )

    assert {report["path"] for report in result.manifest["images"]} == {
        "images/morphology:htj2k_q0.0005/0",
        "images/histology:htj2k_q0.0005/0",
    }
    for image_key in ("morphology", "histology"):
        original_meta = json.loads(
            (result.store_path / "images" / image_key / "0" / "zarr.json").read_text()
        )
        assert original_meta["codecs"] != [
            {"name": CODEC_HTJ2K_OPENJPH, "configuration": {}}
        ]

        sibling_meta = json.loads(
            (
                result.store_path
                / "images"
                / f"{image_key}:htj2k_q0.0005"
                / "0"
                / "zarr.json"
            ).read_text()
        )
        assert sibling_meta["codecs"] == [
            {"name": CODEC_HTJ2K_OPENJPH, "configuration": {}}
        ]


def test_preset_encode_options_quality_implies_lossy_htj2k() -> None:
    assert _preset_encode_options(
        {"quality": 0.001},
        codec=CODEC_HTJ2K_OPENJPH,
        dtype=np.dtype("uint16"),
    ) == {"reversible": False, "quality": 0.001}
    assert _preset_encode_options(
        {"preset": "lossless", "quality": 0.001},
        codec=CODEC_HTJ2K_OPENJPH,
        dtype=np.dtype("uint16"),
    ) == {"reversible": False, "quality": 0.001}


def test_lossy_presets_are_not_extreme_low_bitrate() -> None:
    assert JP2K_PRESETS["balanced"] == {"reversible": False, "level": 100}
    assert JP2K_PRESETS["small"] == {"reversible": False, "level": 75}


def test_htj2k_presets_do_not_pass_jp2k_rate_control_levels() -> None:
    assert HTJ2K_PRESETS["balanced"] == {"reversible": False, "quality_lsb": 2.0}
    assert HTJ2K_PRESETS["small"] == {"reversible": False, "quality_lsb": 5.0}
    assert "level" not in HTJ2K_PRESETS["balanced"]
    assert _preset_encode_options(
        {"preset": "balanced"},
        codec=CODEC_HTJ2K_OPENJPH,
        dtype=np.dtype("uint16"),
    ) == {"reversible": False, "quality": 2.0 / 65536}
    assert _preset_encode_options(
        {"preset": "balanced"},
        codec=CODEC_JPEG2K,
    ) == {"reversible": False, "level": 100}


def test_htj2k_preset_quality_scales_with_bit_depth() -> None:
    """A preset is a fidelity target in LSB, so its step tracks the bit depth."""
    for preset, lsb in (("balanced", 2.0), ("small", 5.0)):
        assert htj2k_preset_quality(preset, np.dtype("uint8")) == lsb / 256
        assert htj2k_preset_quality(preset, np.dtype("int8")) == lsb / 256
        assert htj2k_preset_quality(preset, np.dtype("uint16")) == lsb / 65536
        assert htj2k_preset_quality(preset, np.dtype("int16")) == lsb / 65536
    assert htj2k_preset_quality("lossless", np.dtype("uint8")) is None


def test_lossy_presets_stay_above_the_input_resolution_floor() -> None:
    """Below ~1 LSB the irreversible path is strictly dominated by reversible."""
    for dtype in (np.dtype("uint8"), np.dtype("int8"), np.dtype("uint16"), np.dtype("int16")):
        floor = HTJ2K_QUALITY_FLOOR_LSB * dtype_quantum(dtype)
        for preset in ("balanced", "small"):
            assert htj2k_preset_quality(preset, dtype) > floor


def test_resolving_an_htj2k_preset_without_a_dtype_is_an_error() -> None:
    with pytest.raises(ValueError, match="needs the input dtype"):
        _preset_encode_options({"preset": "balanced"}, codec=CODEC_HTJ2K_OPENJPH)


def test_explicit_quality_finer_than_the_input_lsb_warns() -> None:
    with pytest.warns(UserWarning, match="finer than one uint8 LSB"):
        _preset_encode_options(
            {"quality": 0.0002}, codec=CODEC_HTJ2K_OPENJPH, dtype=np.dtype("uint8")
        )
    # The same step is a sane request for uint16, where it is ~13 LSB.
    with warnings.catch_warnings():
        warnings.simplefilter("error")
        _preset_encode_options(
            {"quality": 0.0002}, codec=CODEC_HTJ2K_OPENJPH, dtype=np.dtype("uint16")
        )


@pytest.mark.skipif(
    not htj2k_available(),
    reason="No HTJ2K encoder is available in this environment.",
)
def test_htj2k_balanced_preset_produces_reasonable_chunk_size() -> None:
    plane = mandelbrot_plane(256)
    options = _preset_encode_options(
        {"preset": "balanced"},
        codec=CODEC_HTJ2K_OPENJPH,
        dtype=plane.dtype,
    )
    encoded = encode_image_plane(plane, CODEC_HTJ2K_OPENJPH, options)
    assert 1_000 < len(encoded) < plane.nbytes


def _encoded_preset_sizes(plane: np.ndarray) -> dict[str, int]:
    sizes = {}
    for preset in ("lossless", "balanced", "small"):
        options = _preset_encode_options(
            {"preset": preset}, codec=CODEC_HTJ2K_OPENJPH, dtype=plane.dtype
        )
        sizes[preset] = len(encode_image_plane(plane, CODEC_HTJ2K_OPENJPH, options))
    return sizes


@pytest.mark.skipif(
    not htj2k_available(),
    reason="No HTJ2K encoder is available in this environment.",
)
@pytest.mark.parametrize("dtype", ["uint8", "uint16"])
def test_htj2k_lossy_presets_are_smaller_than_lossless(dtype: str) -> None:
    """size(small) <= size(balanced) <= size(lossless), at every bit depth.

    This ordering is what a user asking for a smaller file assumes. It used to
    be reversed for uint8: the presets were absolute quantization steps tuned on
    uint16, so on 8-bit input they asked for a step ~20x finer than the data's
    own resolution and the irreversible path spent more bits than the reversible
    one to return a bit-identical image. `balanced` encoded 2.8x LARGER than
    `lossless` on this plane.
    """
    plane = mandelbrot_plane(256)
    if dtype == "uint8":
        plane = (plane >> 8).astype(np.uint8)

    sizes = _encoded_preset_sizes(plane)

    assert sizes["small"] <= sizes["balanced"] <= sizes["lossless"], sizes
    # Not merely ordered — a lossy preset has to actually buy something.
    assert sizes["small"] < sizes["lossless"], sizes


@pytest.mark.skipif(
    not htj2k_available(),
    reason="No HTJ2K encoder is available in this environment.",
)
def test_htj2k_presets_hold_fidelity_across_bit_depths() -> None:
    """The same preset costs the same error *in LSB* whatever the dtype.

    That equivalence is the point of expressing presets as an LSB multiple: the
    uint8 plane and the uint16 plane holding the same picture must degrade
    alike, rather than the uint16 one being quantized 256x more coarsely.
    """
    plane8 = (mandelbrot_plane(256) >> 8).astype(np.uint8)
    plane16 = plane8.astype(np.uint16)

    options8 = _preset_encode_options(
        {"preset": "balanced"}, codec=CODEC_HTJ2K_OPENJPH, dtype=plane8.dtype
    )
    options16 = _preset_encode_options(
        {"preset": "balanced"}, codec=CODEC_HTJ2K_OPENJPH, dtype=plane16.dtype
    )
    assert options16["quality"] == options8["quality"] / 256

    error8 = np.abs(
        decode_htj2k_plane(encode_image_plane(plane8, CODEC_HTJ2K_OPENJPH, options8))
        .reshape(plane8.shape)
        .astype(np.int64)
        - plane8.astype(np.int64)
    )
    error16 = np.abs(
        decode_htj2k_plane(encode_image_plane(plane16, CODEC_HTJ2K_OPENJPH, options16))
        .reshape(plane16.shape)
        .astype(np.int64)
        - plane16.astype(np.int64)
    )
    # Same picture, same preset, same absolute error — the uint16 container
    # does not make the encode coarser.
    assert error16.mean() == pytest.approx(error8.mean(), abs=0.05)


def test_recompress_spatialdata_rewrites_image_and_labels(tmp_path: Path) -> None:
    source = _write_source_store(tmp_path / "source.zarr")

    result = recompress_spatialdata(
        source,
        tmp_path / "out.zarr",
        config={
            "images": {"morphology": {"preset": "lossless", "chunks": [1, 4, 4]}},
            "default_labels": {"codec": "blosc", "clevel": 5},
        },
    )

    assert (result.store_path / "tables" / "table" / "zarr.json").exists()
    image_meta = json.loads(
        (result.store_path / "images" / "morphology" / "0" / "zarr.json").read_text()
    )
    assert image_meta["codecs"] == [{"name": "imagecodecs_jpeg2k", "configuration": {}}]
    assert image_meta["chunk_grid"]["configuration"]["chunk_shape"] == [1, 4, 4]

    first_chunk = result.manifest["images"][0]["chunks_checked"][0]
    encoded = result.store_path / "images" / "morphology" / "0" / "c" / "0" / "0" / "0"
    decoded = imagecodecs.jpeg2k_decode(encoded.read_bytes())
    assert first_chunk["source_sha256"] == first_chunk["decoded_sha256"]
    assert int(decoded[0, 0]) == 0

    label_meta = json.loads(
        (result.store_path / "labels" / "cells" / "0" / "zarr.json").read_text()
    )
    assert [codec["name"] for codec in label_meta["codecs"]] == ["bytes", "blosc"]
    assert result.manifest_path is not None
    assert result.manifest_path.exists()


def test_recompress_spatialdata_rejects_browser_unsupported_jp2k_dtype(tmp_path: Path) -> None:
    source = _write_source_store(tmp_path / "source.zarr", image_dtype="uint32")

    with pytest.raises(TypeError, match="<=16-bit integer"):
        recompress_spatialdata(
            source,
            tmp_path / "out.zarr",
            config={"images": {"morphology": {"preset": "lossless"}}},
        )


def test_recompress_preserves_root_spatialdata_attrs(tmp_path: Path) -> None:
    source = _write_source_store(tmp_path / "source.zarr")
    original_attrs = json.loads((source / "zarr.json").read_text())["attributes"]

    result = recompress_spatialdata(
        source,
        tmp_path / "out.zarr",
        config={
            "images": {"morphology": {"preset": "lossless", "chunks": [1, 4, 4]}},
            "default_labels": {"codec": None},
        },
    )

    preserved = json.loads((result.store_path / "zarr.json").read_text())["attributes"]
    assert preserved == original_attrs


def test_recompress_sibling_keeps_original_and_adds_new_group(tmp_path: Path) -> None:
    source = _write_source_store(tmp_path / "source.zarr")

    result = recompress_spatialdata(
        source,
        tmp_path / "out.zarr",
        config={
            "images": {"morphology": {"preset": "lossless", "chunks": [1, 4, 4]}},
            "default_labels": {"codec": None},
        },
        sibling=True,
    )

    # Original group is untouched — still has its original zarr metadata (no JP2K codec).
    original_meta = json.loads(
        (result.store_path / "images" / "morphology" / "0" / "zarr.json").read_text()
    )
    assert original_meta["codecs"] != [{"name": "imagecodecs_jpeg2k", "configuration": {}}]

    # Sibling group exists with the encoding-annotated name.
    sibling_key = "morphology:jp2k_lossless"
    sibling_meta = json.loads(
        (result.store_path / "images" / sibling_key / "0" / "zarr.json").read_text()
    )
    assert sibling_meta["codecs"] == [{"name": "imagecodecs_jpeg2k", "configuration": {}}]

    # Manifest records the sibling path, not the original.
    assert result.manifest["images"][0]["path"] == f"images/{sibling_key}/0"


def test_lossy_preset_records_non_lossless_manifest(tmp_path: Path) -> None:
    source = _write_source_store(tmp_path / "source.zarr")

    result = recompress_spatialdata(
        source,
        tmp_path / "out.zarr",
        config={
            "images": {"morphology": {"preset": "small", "chunks": [1, 4, 4]}},
            "default_labels": {"codec": None},
        },
    )

    image_report = result.manifest["images"][0]
    assert image_report["preset"] == "small"
    assert image_report["lossless"] is False
    assert image_report["encode_options"]["reversible"] is False


def test_recompress_rejects_unknown_image_codec(tmp_path: Path) -> None:
    source = _write_source_store(tmp_path / "source.zarr")

    with pytest.raises(ValueError, match="Unsupported image codec"):
        recompress_spatialdata(
            source,
            tmp_path / "out.zarr",
            config={"images": {"morphology": {"codec": "imagecodecs_jxl"}}},
        )


@pytest.mark.skipif(
    htj2k_available(),
    reason="HTJ2K encode is available; unavailable-path test not applicable.",
)
def test_recompress_rejects_htj2k_when_encode_unavailable(tmp_path: Path) -> None:
    source = _write_source_store(tmp_path / "source.zarr")

    with pytest.raises(RuntimeError, match="HTJ2K recompression requested"):
        recompress_spatialdata(
            source,
            tmp_path / "out.zarr",
            config={
                "images": {
                    "morphology": {
                        "codec": CODEC_HTJ2K_OPENJPH,
                        "preset": "lossless",
                        "chunks": [1, 4, 4],
                    }
                },
                "default_labels": {"codec": None},
            },
        )


@pytest.mark.skipif(
    not htj2k_available(),
    reason="No HTJ2K encoder is available in this environment.",
)
def test_recompress_spatialdata_rewrites_image_with_htj2k(tmp_path: Path) -> None:
    source = _write_source_store(tmp_path / "source.zarr")

    result = recompress_spatialdata(
        source,
        tmp_path / "out.zarr",
        config={
            "images": {
                "morphology": {
                    "codec": CODEC_HTJ2K_OPENJPH,
                    "preset": "lossless",
                    "chunks": [1, 4, 4],
                }
            },
            "default_labels": {"codec": None},
        },
    )

    image_meta = json.loads(
        (result.store_path / "images" / "morphology" / "0" / "zarr.json").read_text()
    )
    assert image_meta["codecs"] == [
        {"name": CODEC_HTJ2K_OPENJPH, "configuration": {}}
    ]

    first_chunk = result.manifest["images"][0]["chunks_checked"][0]
    encoded = result.store_path / "images" / "morphology" / "0" / "c" / "0" / "0" / "0"
    decoded = decode_htj2k_plane(encoded.read_bytes())
    assert first_chunk["source_sha256"] == first_chunk["decoded_sha256"]
    assert int(decoded[0, 0]) == 0
    assert result.manifest["images"][0]["codec"] == CODEC_HTJ2K_OPENJPH
    assert result.manifest["images"][0]["encoder"] == "openjph"
    # Which OpenJPH build produced the bytes is recorded separately, since
    # either the native (imagecodecs) or WASM backend may have been selected.
    assert result.manifest["images"][0]["encoder_backend"] in {"imagecodecs", "openjph-wasm"}


@pytest.mark.skipif(
    not htj2k_available(),
    reason="No HTJ2K encoder is available in this environment.",
)
def test_recompress_sibling_uses_htj2k_key(tmp_path: Path) -> None:
    source = _write_source_store(tmp_path / "source.zarr")

    result = recompress_spatialdata(
        source,
        tmp_path / "out.zarr",
        config={
            "images": {
                "morphology": {
                    "codec": CODEC_HTJ2K_OPENJPH,
                    "preset": "balanced",
                    "chunks": [1, 4, 4],
                }
            },
            "default_labels": {"codec": None},
        },
        sibling=True,
    )

    sibling_key = "morphology:htj2k_balanced"
    sibling_meta = json.loads(
        (result.store_path / "images" / sibling_key / "0" / "zarr.json").read_text()
    )
    assert sibling_meta["codecs"] == [
        {"name": CODEC_HTJ2K_OPENJPH, "configuration": {}}
    ]
    assert result.manifest["images"][0]["path"] == f"images/{sibling_key}/0"
