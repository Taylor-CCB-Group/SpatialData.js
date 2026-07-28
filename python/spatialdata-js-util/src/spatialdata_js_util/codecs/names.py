"""Codec identifiers shared by the writer, the reader shim, and the JS runtime.

These strings are the `name` field of the zarr v3 array metadata `codecs` entry,
so they are part of the on-disk contract. They must stay in sync with
`packages/zarrextra/src/codecs.ts`.
"""

from __future__ import annotations

from typing import Literal

CODEC_JPEG2K = "imagecodecs_jpeg2k"
CODEC_HTJ2K_OPENJPH = "experimental.openjph_htj2k"
# Legacy label for stores written before OpenJPH became the supported encoder.
CODEC_HTJ2K_LEGACY = "experimental.imagecodecs_htj2k"

HTJ2K_CODECS = frozenset({CODEC_HTJ2K_OPENJPH, CODEC_HTJ2K_LEGACY})
SUPPORTED_IMAGE_CODECS = frozenset({CODEC_JPEG2K, CODEC_HTJ2K_OPENJPH})

HTJ2K_ENCODER = "openjph"

CodecName = Literal["imagecodecs_jpeg2k", "experimental.openjph_htj2k"]


def is_htj2k_codec(codec: str) -> bool:
    return codec in HTJ2K_CODECS
