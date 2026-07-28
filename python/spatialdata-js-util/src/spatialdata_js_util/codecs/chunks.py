"""Chunk-grid arithmetic shared by the recompressor and its tests."""

from __future__ import annotations

import numpy as np


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
