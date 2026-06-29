from __future__ import annotations

import hashlib
import json
from importlib import metadata
from pathlib import Path
from typing import Any, Literal

# `imagecodecs` is used only for the JPEG2000 (`imagecodecs_jpeg2k`) path. The
# HTJ2K path goes through the vendored openjph-wasm worker (the same WASM the JS
# reader uses), so it round-trips genuine multi-component (volumetric) data and
# stays consistent encode-vs-decode. We deliberately do not maintain extra HTJ2K
# backends here: native `imagecodecs` HTJ2K is build-fragile, and `itkwasm-htj2k`
# (https://pypi.org/project/itkwasm-htj2k/) has been unmaintained for ~2 years.
# If we ever drop the JPEG2000 fixture path, `imagecodecs` can be removed too.
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
    """Decode an HTJ2K codestream via the vendored openjph-wasm worker.

    Returns a 2D ``(y, x)`` array for single-component codestreams, otherwise a
    ``(components, y, x)`` array.
    """
    from .htj2k_encode import decode_htj2k

    array = decode_htj2k(encoded)
    return array[0] if array.shape[0] == 1 else array


def decode_image_plane(encoded: bytes | bytearray, codec: str) -> np.ndarray:
    if codec == CODEC_JPEG2K:
        return imagecodecs.jpeg2k_decode(encoded)
    if is_htj2k_codec(codec):
        return decode_htj2k_plane(encoded)
    raise ValueError(f"Unsupported image codec: {codec}")


def _htj2k_components(array: np.ndarray) -> int:
    return int(np.prod(array.shape[:-2])) if array.ndim > 2 else 1


def _encode_htj2k_with_options(
    volume: np.ndarray, encode_options: dict[str, Any] | None = None
) -> bytes | bytearray:
    from .htj2k_encode import encode_htj2k, htj2k_encode_available, openjph_encode_options

    if not htj2k_encode_available():
        raise RuntimeError(
            "HTJ2K encode is not available. Install spatialdata-codec-writer with Node.js on PATH."
        )
    reversible, quality = openjph_encode_options(encode_options or {})
    return encode_htj2k(volume, reversible=reversible, quality=quality)


def encode_image_plane(
    plane: np.ndarray, codec: str, encode_options: dict[str, Any]
) -> bytes | bytearray:
    array = np.asarray(plane)
    if codec == CODEC_JPEG2K:
        return imagecodecs.jpeg2k_encode(array, **encode_options)
    if codec == CODEC_HTJ2K_OPENJPH:
        return _encode_htj2k_with_options(array, encode_options)
    raise ValueError(f"Unsupported image codec: {codec}")


def encode_image_chunk(
    volume: np.ndarray, codec: str, encode_options: dict[str, Any]
) -> bytes | bytearray:
    """Encode a chunk of one or more planar components to a single codestream.

    ``volume`` is ``(components, y, x)`` (or 2D for a single component). HTJ2K
    encodes the planes as codestream components (e.g. z-planes of a volumetric
    chunk); multi-component JPEG2K chunks are not produced by this writer.
    """
    array = np.ascontiguousarray(np.asarray(volume))
    components = _htj2k_components(array)
    if codec == CODEC_HTJ2K_OPENJPH:
        return _encode_htj2k_with_options(array, encode_options)
    if codec == CODEC_JPEG2K:
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
        from .htj2k_encode import decode_htj2k

        return decode_htj2k(encoded).reshape(components, height, width)
    if codec == CODEC_JPEG2K:
        decoded = np.asarray(imagecodecs.jpeg2k_decode(encoded))
        if decoded.ndim == 2:
            return decoded.reshape(1, height, width)
        return np.moveaxis(decoded, -1, 0).reshape(components, height, width)
    raise ValueError(f"Unsupported image codec: {codec}")


def chunk_grid(shape: tuple[int, ...], chunks: tuple[int, ...]) -> list[tuple[int, ...]]:
    if len(shape) != len(chunks):
        raise ValueError(
            f"shape and chunks must have the same length (got {len(shape)} and {len(chunks)})"
        )
    ranges = [range((size + chunk - 1) // chunk) for size, chunk in zip(shape, chunks)]
    out: list[tuple[int, ...]] = [()]
    for values in ranges:
        out = [(*prefix, value) for prefix in out for value in values]
    return out


def chunk_slices(
    shape: tuple[int, ...], chunks: tuple[int, ...], coords: tuple[int, ...]
) -> tuple[slice, ...]:
    if not (len(shape) == len(chunks) == len(coords)):
        raise ValueError(
            "shape, chunks, and coords must have the same length "
            f"(got {len(shape)}, {len(chunks)}, and {len(coords)})"
        )
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
