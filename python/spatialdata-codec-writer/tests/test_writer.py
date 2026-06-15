from pathlib import Path

import imagecodecs
import numpy as np

from spatialdata_codec_writer import (
    image_to_tczyx,
    write_codec_spatialdata,
    write_codec_spatialdata_image,
    write_jpeg2k_fixture,
)


class FakeImage:
    def __init__(self, data: np.ndarray, dims: tuple[str, ...]) -> None:
        self.data = data
        self.dims = dims


class FakeSpatialData:
    def __init__(self, image_key: str, image: FakeImage) -> None:
        self.images = {image_key: image}


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


def test_image_to_tczyx_uses_named_dimensions() -> None:
    image = FakeImage(np.arange(40, dtype=np.uint16).reshape(2, 4, 5), ("c", "y", "x"))

    normalized = image_to_tczyx(image)

    assert normalized.shape == (1, 2, 1, 4, 5)
    assert int(normalized[0, 1, 0, 3, 4]) == 39


def test_image_to_tczyx_uses_base_scale_for_multiscale_spatialdata_image() -> None:
    from spatialdata.models import Image2DModel

    image = Image2DModel.parse(
        np.arange(64, dtype=np.uint16).reshape(1, 8, 8),
        dims=("c", "y", "x"),
        scale_factors=[2],
    )

    normalized = image_to_tczyx(image)

    assert normalized.shape == (1, 1, 1, 8, 8)
    assert int(normalized[0, 0, 0, 7, 7]) == 63


def test_write_codec_spatialdata_accepts_named_image_key(tmp_path: Path) -> None:
    image = FakeImage(np.arange(40, dtype=np.uint16).reshape(2, 4, 5), ("c", "y", "x"))

    fixture = write_codec_spatialdata(
        tmp_path / "named.zarr",
        image=image,
        image_key="histology",
        chunks=(1, 1, 1, 4, 5),
    )

    assert fixture.manifest["image_path"] == "images/histology"
    assert (fixture.store_path / "images" / "histology" / "zarr.json").exists()


def test_write_codec_spatialdata_image_transcodes_existing_image(tmp_path: Path) -> None:
    image = FakeImage(np.arange(40, dtype=np.uint16).reshape(2, 4, 5), ("c", "y", "x"))
    sdata = FakeSpatialData("histology", image)

    fixture = write_codec_spatialdata_image(
        tmp_path / "transcoded.zarr",
        sdata,
        image_key="histology",
        chunks=(1, 1, 1, 4, 5),
    )

    assert fixture.manifest["image_path"] == "images/histology"
    assert fixture.manifest["shape"] == [1, 2, 1, 4, 5]
