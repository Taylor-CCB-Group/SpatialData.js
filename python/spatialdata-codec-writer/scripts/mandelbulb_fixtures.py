from __future__ import annotations

from pathlib import Path

from spatialdata_codec_writer.codecs import CODEC_HTJ2K_OPENJPH

from fixture_writer import WrittenFixture, write_codec_spatialdata
from synthetic_images import volume_tczyx

MANDELBULB_FIXTURE_SIZE = 128
MANDELBULB_FIXTURE_T = 2
MANDELBULB_FIXTURE_C = 1
MANDELBULB_FIXTURE_Z = 8
MANDELBULB_FIXTURE_CHUNKS: tuple[int, int, int, int, int] = (1, 1, 1, 128, 128)
MANDELBULB_FIXTURE_IMAGE_KEY = "mandelbulb"
MANDELBULB_ENCODE_OPTIONS = {"reversible": True}


def mandelbulb_fixture_volume():
    return volume_tczyx(
        MANDELBULB_FIXTURE_SIZE,
        t=MANDELBULB_FIXTURE_T,
        c=MANDELBULB_FIXTURE_C,
        z=MANDELBULB_FIXTURE_Z,
        pattern="mandelbulb",
    )


def write_mandelbulb_fixture(path: str | Path, *, overwrite: bool = False) -> WrittenFixture:
    return write_codec_spatialdata(
        path,
        codec=CODEC_HTJ2K_OPENJPH,
        image=mandelbulb_fixture_volume(),
        image_key=MANDELBULB_FIXTURE_IMAGE_KEY,
        chunks=MANDELBULB_FIXTURE_CHUNKS,
        multiscale=False,
        encode_options=MANDELBULB_ENCODE_OPTIONS,
        overwrite=overwrite,
    )
