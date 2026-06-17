"""Experimental provenance marker for codec test fixtures (not spatialdata.write() artifacts)."""

from __future__ import annotations

from importlib import metadata

EXPERIMENTAL_CODEC_WRITER_VERSION = "0.1.0"
DEFAULT_SPATIALDATA_VERSION = "0.7.2"


def _spatialdata_version() -> str:
    try:
        return metadata.version("spatialdata")
    except metadata.PackageNotFoundError:
        return DEFAULT_SPATIALDATA_VERSION


def experimental_codec_writer_attrs() -> dict[str, str]:
    return {
        # readZarr validates raster attrs against spatialDataAttrsSchema, which
        # requires a spatialdata library version even for experimental fixtures.
        "version": _spatialdata_version(),
        "experimental_codec_writer": EXPERIMENTAL_CODEC_WRITER_VERSION,
        "note": "codec test fixture; not a spatialdata.write() artifact",
    }
