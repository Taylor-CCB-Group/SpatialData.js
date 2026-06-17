from __future__ import annotations

import json
from pathlib import Path

import imagecodecs
import numpy as np
import pytest
import zarr

from spatialdata_codec_writer import (
    CODEC_HTJ2K_EXPERIMENTAL,
    CODEC_JPEG2K,
    HTJ2K_PRESETS,
    JP2K_PRESETS,
    htj2k_encode_available,
    recompress_spatialdata,
    resolve_recompression_config,
)
from spatialdata_codec_writer.recompress import _encode_image_plane, _preset_encode_options


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
        codec=CODEC_HTJ2K_EXPERIMENTAL,
        preset="lossless",
    )

    assert config["images"]["morphology"]["codec"] == CODEC_HTJ2K_EXPERIMENTAL
    assert config["images"]["morphology"]["preset"] == "lossless"
    assert config["default_image"]["codec"] == "imagecodecs_jpeg2k"


def test_lossy_presets_are_not_extreme_low_bitrate() -> None:
    assert JP2K_PRESETS["balanced"] == {"reversible": False, "level": 100}
    assert JP2K_PRESETS["small"] == {"reversible": False, "level": 75}


def test_htj2k_presets_do_not_pass_jp2k_rate_control_levels() -> None:
    assert HTJ2K_PRESETS["balanced"] == {"reversible": False, "quality": 100}
    assert HTJ2K_PRESETS["small"] == {"reversible": False, "quality": 75}
    assert "level" not in HTJ2K_PRESETS["balanced"]
    assert _preset_encode_options(
        {"preset": "balanced"},
        codec=CODEC_HTJ2K_EXPERIMENTAL,
    ) == {"reversible": False, "quality": 100}
    assert _preset_encode_options(
        {"preset": "balanced"},
        codec=CODEC_JPEG2K,
    ) == {"reversible": False, "level": 100}


@pytest.mark.skipif(
    not htj2k_encode_available(),
    reason="No HTJ2K encoder is available in this environment.",
)
def test_htj2k_balanced_preset_produces_reasonable_chunk_size() -> None:
    plane = np.random.randint(0, 4096, (256, 256), dtype=np.uint16)
    options = _preset_encode_options(
        {"preset": "balanced"},
        codec=CODEC_HTJ2K_EXPERIMENTAL,
    )
    encoded = _encode_image_plane(plane, CODEC_HTJ2K_EXPERIMENTAL, options)
    assert len(encoded) > 10_000


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
    htj2k_encode_available(),
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
                        "codec": CODEC_HTJ2K_EXPERIMENTAL,
                        "preset": "lossless",
                        "chunks": [1, 4, 4],
                    }
                },
                "default_labels": {"codec": None},
            },
        )


@pytest.mark.skipif(
    not htj2k_encode_available(),
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
                    "codec": CODEC_HTJ2K_EXPERIMENTAL,
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
        {"name": CODEC_HTJ2K_EXPERIMENTAL, "configuration": {}}
    ]

    first_chunk = result.manifest["images"][0]["chunks_checked"][0]
    encoded = result.store_path / "images" / "morphology" / "0" / "c" / "0" / "0" / "0"
    decoder = getattr(imagecodecs, "htj2k_decode", imagecodecs.jpeg2k_decode)
    decoded = decoder(encoded.read_bytes())
    assert first_chunk["source_sha256"] == first_chunk["decoded_sha256"]
    assert int(decoded[0, 0]) == 0
    assert result.manifest["images"][0]["codec"] == CODEC_HTJ2K_EXPERIMENTAL


@pytest.mark.skipif(
    not htj2k_encode_available(),
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
                    "codec": CODEC_HTJ2K_EXPERIMENTAL,
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
        {"name": CODEC_HTJ2K_EXPERIMENTAL, "configuration": {}}
    ]
    assert result.manifest["images"][0]["path"] == f"images/{sibling_key}/0"
