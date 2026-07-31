"""Encode and decode image chunks for the codecs this package supports.

JPEG 2000 goes through `imagecodecs`. HTJ2K goes through whichever backend
`backends.resolve_backend()` selects. Both directions are expressed in terms of
planar ``(components, y, x)`` volumes; 2D planes are the single-component case.
"""

from __future__ import annotations

from typing import Any

import numpy as np

from .backends import require_backend
from .names import CODEC_HTJ2K_OPENJPH, CODEC_JPEG2K, is_htj2k_codec


def htj2k_encode_options(encode_options: dict[str, Any]) -> tuple[bool, float]:
    """Map encode options to the OpenJPH ``(reversible, quality)`` pair.

    ``quality`` is the OpenJPH quantization step: lower means higher fidelity and
    a larger codestream. It is *not* a JPEG-style 0–100 quality.
    """
    reversible = bool(encode_options.get("reversible", True))
    if reversible:
        return True, 0.0
    quality = encode_options.get("quality", encode_options.get("level", 0.0002))
    return False, float(quality)


def _encode_htj2k(volume: np.ndarray, encode_options: dict[str, Any] | None = None) -> bytes:
    reversible, quality = htj2k_encode_options(encode_options or {})
    return require_backend().encode(volume, reversible=reversible, quality=quality)


def _htj2k_components(array: np.ndarray) -> int:
    return int(np.prod(array.shape[:-2])) if array.ndim > 2 else 1


def decode_htj2k_plane(encoded: bytes | bytearray) -> np.ndarray:
    """Decode an HTJ2K codestream.

    Returns a 2D ``(y, x)`` array for single-component codestreams, otherwise a
    ``(components, y, x)`` array.
    """
    array = require_backend().decode(encoded)
    return array[0] if array.shape[0] == 1 else array


def decode_image_plane(encoded: bytes | bytearray, codec: str) -> np.ndarray:
    if codec == CODEC_JPEG2K:
        import imagecodecs

        return imagecodecs.jpeg2k_decode(encoded)
    if is_htj2k_codec(codec):
        return decode_htj2k_plane(encoded)
    raise ValueError(f"Unsupported image codec: {codec}")


def encode_image_plane(
    plane: np.ndarray, codec: str, encode_options: dict[str, Any]
) -> bytes | bytearray:
    array = np.asarray(plane)
    if codec == CODEC_JPEG2K:
        import imagecodecs

        return imagecodecs.jpeg2k_encode(array, **encode_options)
    if codec == CODEC_HTJ2K_OPENJPH:
        return _encode_htj2k(array, encode_options)
    raise ValueError(f"Unsupported image codec: {codec}")


def encode_image_chunk(
    volume: np.ndarray, codec: str, encode_options: dict[str, Any]
) -> bytes | bytearray:
    """Encode one or more planar components to a single codestream.

    ``volume`` is ``(components, y, x)`` (or 2D for a single component). HTJ2K
    encodes the planes as codestream components (e.g. z-planes of a volumetric
    chunk); multi-component JPEG2K chunks are not produced by this writer.
    """
    array = np.ascontiguousarray(np.asarray(volume))
    components = _htj2k_components(array)
    if codec == CODEC_HTJ2K_OPENJPH:
        return _encode_htj2k(array, encode_options)
    if codec == CODEC_JPEG2K:
        import imagecodecs

        if components == 1:
            plane = array.reshape(array.shape[-2], array.shape[-1])
            return imagecodecs.jpeg2k_encode(plane, **encode_options)
        raise NotImplementedError(
            "Multi-component JPEG2K chunks are not supported; use HTJ2K (openjph)."
        )
    raise ValueError(f"Unsupported image codec: {codec}")


def decode_image_chunk(
    encoded: bytes | bytearray, codec: str, *, components: int, height: int, width: int
) -> np.ndarray:
    """Decode a chunk codestream to a ``(components, y, x)`` array."""
    if is_htj2k_codec(codec):
        return require_backend().decode(encoded).reshape(components, height, width)
    if codec == CODEC_JPEG2K:
        import imagecodecs

        decoded = np.asarray(imagecodecs.jpeg2k_decode(encoded))
        if decoded.ndim == 2:
            return decoded.reshape(1, height, width)
        return np.moveaxis(decoded, -1, 0).reshape(components, height, width)
    raise ValueError(f"Unsupported image codec: {codec}")
