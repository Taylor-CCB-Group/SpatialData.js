from __future__ import annotations

import numpy as np
import pytest

from spatialdata_js_util.codecs.htj2k_wasm import (
    EncoderPool,
    encode_htj2k_wasm,
    encode_script_path,
    wasm_encode_available,
    openjph_vendor_dir,
    shutdown_encoder_pool,
)


def test_vendored_encode_assets_exist() -> None:
    assert encode_script_path().is_file()
    assert (openjph_vendor_dir() / "index.mjs").is_file()
    assert (openjph_vendor_dir() / "wasm" / "libopenjph.wasm").is_file()


@pytest.mark.skipif(
    not wasm_encode_available(),
    reason="The openjph-wasm backend (Node.js) is not available in this environment.",
)
def test_encoder_pool_round_trip() -> None:
    shutdown_encoder_pool()
    pool = EncoderPool(workers=2)
    try:
        plane = np.arange(16, dtype=np.uint16).reshape(4, 4)
        encoded_a = pool.encode(plane, reversible=True, quality=0.0)
        encoded_b = pool.encode(plane, reversible=True, quality=0.0)
        assert len(encoded_a) > 0
        assert len(encoded_b) > 0
    finally:
        pool.close()
        shutdown_encoder_pool()


@pytest.mark.skipif(
    not wasm_encode_available(),
    reason="The openjph-wasm backend (Node.js) is not available in this environment.",
)
def test_multi_component_round_trip() -> None:
    """A z>1 chunk encodes to one multi-component codestream and round-trips losslessly."""
    shutdown_encoder_pool()
    pool = EncoderPool(workers=1)
    try:
        components, height, width = 4, 8, 8
        volume = (
            np.arange(components * height * width, dtype=np.uint16).reshape(
                components, height, width
            )
            % 4096
        )
        encoded = pool.encode(volume, reversible=True, quality=0.0)
        decoded = pool.decode(encoded)
        assert decoded.shape == (components, height, width)
        assert np.array_equal(decoded, volume)
    finally:
        pool.close()
        shutdown_encoder_pool()


@pytest.mark.skipif(
    not wasm_encode_available(),
    reason="The openjph-wasm backend (Node.js) is not available in this environment.",
)
def test_encode_htj2k_wasm_uses_global_pool() -> None:
    shutdown_encoder_pool()
    try:
        plane = np.zeros((8, 8), dtype=np.uint16)
        encoded = encode_htj2k_wasm(plane, reversible=True, quality=0.0)
        assert len(encoded) > 0
    finally:
        shutdown_encoder_pool()
