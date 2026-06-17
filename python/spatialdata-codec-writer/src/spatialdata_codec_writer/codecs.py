from __future__ import annotations

import hashlib
import json
from importlib import metadata
from pathlib import Path
from typing import Any, Literal

import imagecodecs
import numpy as np

CODEC_JPEG2K = "imagecodecs_jpeg2k"
CODEC_HTJ2K_OPENJPH = "experimental.openjph_htj2k"
# Legacy label for stores written before OpenJPH WASM became the supported encoder.
CODEC_HTJ2K_LEGACY = "experimental.imagecodecs_htj2k"
HTJ2K_CODECS = frozenset({CODEC_HTJ2K_OPENJPH, CODEC_HTJ2K_LEGACY})
HTJ2K_ENCODER = "openjph-wasm"

CodecName = Literal["imagecodecs_jpeg2k", "experimental.openjph_htj2k"]


def is_htj2k_codec(codec: str) -> bool:
    return codec in HTJ2K_CODECS


def package_version(name: str) -> str | None:
    try:
        return metadata.version(name)
    except metadata.PackageNotFoundError:
        return None


def json_bytes(value: dict[str, Any]) -> bytes:
    return json.dumps(value, indent=2, sort_keys=True).encode("utf-8")


def write_json(path: Path, value: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(json_bytes(value))


def sha256(data: bytes | bytearray) -> str:
    return hashlib.sha256(data).hexdigest()


def decode_htj2k_plane(encoded: bytes | bytearray) -> np.ndarray:
    """Decode an HTJ2K plane for validation (native imagecodecs when available)."""
    htj2k = getattr(imagecodecs, "HTJ2K", None)
    if htj2k is not None and getattr(htj2k, "available", False):
        decoder = getattr(imagecodecs, "htj2k_decode", None)
        if decoder is not None:
            return decoder(encoded)
    return imagecodecs.jpeg2k_decode(encoded)


def decode_image_plane(encoded: bytes | bytearray, codec: str) -> np.ndarray:
    if codec == CODEC_JPEG2K:
        return imagecodecs.jpeg2k_decode(encoded)
    if is_htj2k_codec(codec):
        return decode_htj2k_plane(encoded)
    raise ValueError(f"Unsupported image codec: {codec}")


def encode_htj2k_plane_with_options(
    plane: np.ndarray, encode_options: dict[str, Any] | None = None
) -> bytes | bytearray:
    from .htj2k_encode import encode_htj2k_plane, htj2k_encode_available, openjph_encode_options

    if not htj2k_encode_available():
        raise RuntimeError(
            "HTJ2K encode is not available. Install spatialdata-codec-writer with Node.js on PATH."
        )
    reversible, quality = openjph_encode_options(encode_options or {})
    return encode_htj2k_plane(plane, reversible=reversible, quality=quality)


def encode_image_plane(
    plane: np.ndarray, codec: str, encode_options: dict[str, Any]
) -> bytes | bytearray:
    array = np.asarray(plane)
    if codec == CODEC_JPEG2K:
        return imagecodecs.jpeg2k_encode(array, **encode_options)
    if codec == CODEC_HTJ2K_OPENJPH:
        return encode_htj2k_plane_with_options(array, encode_options)
    raise ValueError(f"Unsupported image codec: {codec}")


def chunk_grid(shape: tuple[int, ...], chunks: tuple[int, ...]) -> list[tuple[int, ...]]:
    ranges = [range((size + chunk - 1) // chunk) for size, chunk in zip(shape, chunks)]
    out: list[tuple[int, ...]] = [()]
    for values in ranges:
        out = [(*prefix, value) for prefix in out for value in values]
    return out


def chunk_slices(
    shape: tuple[int, ...], chunks: tuple[int, ...], coords: tuple[int, ...]
) -> tuple[slice, ...]:
    slices = []
    for coord, chunk, size in zip(coords, chunks, shape):
        start = coord * chunk
        slices.append(slice(start, min(start + chunk, size)))
    return tuple(slices)


def pad_chunk(chunk: np.ndarray, chunks: tuple[int, ...]) -> np.ndarray:
    if chunk.shape == chunks:
        return chunk
    padded = np.zeros(chunks, dtype=chunk.dtype)
    padded[tuple(slice(0, size) for size in chunk.shape)] = chunk
    return padded
