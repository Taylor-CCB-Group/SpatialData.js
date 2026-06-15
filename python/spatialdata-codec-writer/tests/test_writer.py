from pathlib import Path

import imagecodecs

from spatialdata_codec_writer import write_jpeg2k_fixture


def test_write_jpeg2k_fixture(tmp_path: Path) -> None:
    fixture = write_jpeg2k_fixture(tmp_path / "jpeg2k.zarr")

    assert fixture.store_path.exists()
    assert fixture.manifest_path.exists()
    assert fixture.manifest["codec"] == "imagecodecs_jpeg2k"

    first_chunk = fixture.manifest["chunks_checked"][0]
    encoded = (fixture.store_path / first_chunk["path"]).read_bytes()
    decoded = imagecodecs.jpeg2k_decode(encoded)

    assert decoded.shape == (32, 32)
    assert int(decoded[0, 0]) == first_chunk["samples"][0]

