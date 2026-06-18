from pathlib import Path

import pytest

from spatialdata_codec_writer import htj2k_encode_available

from htj2k_fixtures import HTJ2K_ENCODE_DEMO_STORE, htj2k_encode_demo_image_key, write_htj2k_encode_demo_fixtures


@pytest.mark.skipif(
    not htj2k_encode_available(),
    reason="No HTJ2K encoder is available in this environment.",
)
def test_htj2k_encode_demo_fixtures(tmp_path: Path) -> None:
    manifest_path = write_htj2k_encode_demo_fixtures(tmp_path, overwrite=True)
    manifest = manifest_path.read_text()

    assert "spatialdata-htj2k-encode-demo/v2" in manifest
    store_path = tmp_path / HTJ2K_ENCODE_DEMO_STORE
    assert store_path.is_dir()
    assert (store_path / "images" / htj2k_encode_demo_image_key("lossless")).is_dir()
    assert (store_path / "images" / htj2k_encode_demo_image_key("balanced")).is_dir()
    assert (store_path / "images" / htj2k_encode_demo_image_key("small")).is_dir()

    import json

    parsed = json.loads(manifest)
    assert parsed["store"] == HTJ2K_ENCODE_DEMO_STORE
    assert parsed["image"]["shape"] == [1, 1, 1, 512, 512]
    assert len(parsed["variants"]) == 3

    lossless = next(v for v in parsed["variants"] if v["suffix"] == "lossless")
    small = next(v for v in parsed["variants"] if v["suffix"] == "small")
    assert lossless["image_key"] == htj2k_encode_demo_image_key("lossless")
    assert lossless["lossless"] is True
    assert small["lossless"] is False
    assert small["encoded_bytes"] < lossless["encoded_bytes"]
