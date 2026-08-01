"""Image codecs for browser-oriented SpatialData stores.

`names` holds the on-disk codec identifiers, `backends` picks an HTJ2K
implementation, `encoding` does the chunk-level work, and `zarr_codec` exposes
all of it to zarr-python as registered codecs.
"""

from .backends import (
    BACKEND_IMAGECODECS,
    BACKEND_OPENJPH_WASM,
    backend_report,
    htj2k_available,
    resolve_backend,
)
from .chunks import chunk_grid, chunk_slices, pad_chunk
from .encoding import (
    HTJ2K_DEFAULT_QUALITY_LSB,
    HTJ2K_QUALITY_FLOOR_LSB,
    decode_htj2k_plane,
    decode_image_chunk,
    decode_image_plane,
    dtype_quantum,
    encode_image_chunk,
    encode_image_plane,
    htj2k_encode_options,
)
from .names import (
    CODEC_HTJ2K_LEGACY,
    CODEC_HTJ2K_OPENJPH,
    CODEC_JPEG2K,
    HTJ2K_ENCODER,
    SUPPORTED_IMAGE_CODECS,
    CodecName,
    is_htj2k_codec,
)
from .zarr_codec import Htj2kCodec, Jpeg2kCodec, LegacyHtj2kCodec, register_codecs

__all__ = [
    "BACKEND_IMAGECODECS",
    "BACKEND_OPENJPH_WASM",
    "CODEC_HTJ2K_LEGACY",
    "CODEC_HTJ2K_OPENJPH",
    "CODEC_JPEG2K",
    "HTJ2K_DEFAULT_QUALITY_LSB",
    "HTJ2K_ENCODER",
    "HTJ2K_QUALITY_FLOOR_LSB",
    "SUPPORTED_IMAGE_CODECS",
    "Htj2kCodec",
    "Jpeg2kCodec",
    "LegacyHtj2kCodec",
    "CodecName",
    "backend_report",
    "chunk_grid",
    "chunk_slices",
    "decode_htj2k_plane",
    "decode_image_chunk",
    "decode_image_plane",
    "dtype_quantum",
    "encode_image_chunk",
    "encode_image_plane",
    "htj2k_available",
    "htj2k_encode_options",
    "is_htj2k_codec",
    "pad_chunk",
    "register_codecs",
    "resolve_backend",
]
