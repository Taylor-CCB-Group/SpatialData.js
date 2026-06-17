"""Experimental provenance marker for codec test fixtures (not spatialdata.write() artifacts)."""

from __future__ import annotations

EXPERIMENTAL_CODEC_WRITER_VERSION = "0.1.0"


def experimental_codec_writer_attrs() -> dict[str, str]:
    return {
        "experimental_codec_writer": EXPERIMENTAL_CODEC_WRITER_VERSION,
        "note": "codec test fixture; not a spatialdata.write() artifact",
    }
