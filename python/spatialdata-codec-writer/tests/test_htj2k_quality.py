from __future__ import annotations

import json
from pathlib import Path

import pytest

from spatialdata_codec_writer import htj2k_encode_available

from htj2k_fixtures import write_htj2k_quality_sweep_manifest


@pytest.mark.skipif(
    not htj2k_encode_available(),
    reason="OpenJPH WASM HTJ2K encoder is not available in this environment.",
)
def test_htj2k_quality_sweep_responds_to_quantization(tmp_path: Path) -> None:
    manifest_path = write_htj2k_quality_sweep_manifest(
        tmp_path / "htj2k-quality-sweep.manifest.json"
    )
    manifest = json.loads(manifest_path.read_text())

    assert manifest["format"] == "spatialdata-htj2k-quality-sweep/v1"
    assert manifest["encoder"] == "openjph-wasm"
    assert manifest["image"]["kind"] == "mandelbrot"

    by_label = {entry["label"]: entry for entry in manifest["qualities"]}
    lossless = by_label["lossless"]
    high = by_label["q0.001"]
    mid = by_label["q0.01"]
    low = by_label["q0.1"]

    assert lossless["rmse"] == 0.0
    assert lossless["encoded_bytes"] > high["encoded_bytes"]
    assert high["encoded_bytes"] > mid["encoded_bytes"]
    assert mid["encoded_bytes"] > low["encoded_bytes"]
    assert high["rmse"] < mid["rmse"] < low["rmse"]
