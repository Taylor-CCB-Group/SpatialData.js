from __future__ import annotations

from typing import Literal

import numpy as np

MANDELBROT_MAX_ITER = 255
MANDELBULB_MAX_ITER = 8
MANDELBULB_POWER = 8


def mandelbrot_plane(size: int) -> np.ndarray:
    """Return a uint16 Mandelbrot escape-time plane as a basic visual quality test."""
    x = np.arange(size, dtype=np.float64)
    y = np.arange(size, dtype=np.float64)
    cr = (x / size) * 3.5 - 2.5
    ci = (y / size) * 2.0 - 1.0
    cr_grid, ci_grid = np.meshgrid(cr, ci)

    zr = np.zeros_like(cr_grid)
    zi = np.zeros_like(ci_grid)
    iteration = np.zeros(cr_grid.shape, dtype=np.int32)
    mask = np.ones(cr_grid.shape, dtype=bool)

    for _ in range(MANDELBROT_MAX_ITER):
        if not np.any(mask):
            break
        zr2 = zr * zr
        zi2 = zi * zi
        nr = zr2 - zi2 + cr_grid
        new_zi = 2.0 * zr * zi + ci_grid
        zr = np.where(mask, nr, zr)
        zi = np.where(mask, new_zi, zi)
        iteration[mask] += 1
        mask &= zr * zr + zi * zi <= 4.0

    return ((iteration * 16) % 4096).astype(np.uint16)


def _indexed_plane(size: int, *, t: int, c: int, z: int) -> np.ndarray:
    y, x = np.mgrid[0:size, 0:size]
    return (t * 1000 + c * 100 + z * 10 + y + x).astype(np.uint16)


def _mandelbulb_plane(
    size: int,
    *,
    z: int,
    z_count: int,
    t: int = 0,
) -> np.ndarray:
    """Sample a lightweight Mandelbulb escape-time field on a y/x plane at fixed z."""
    y_coords = np.linspace(-1.0, 1.0, size, dtype=np.float64)
    x_coords = np.linspace(-1.5, 1.0, size, dtype=np.float64)
    z_coord = (z / max(z_count - 1, 1)) * 2.0 - 1.0 + t * 0.05

    yy, xx = np.meshgrid(y_coords, x_coords, indexing="ij")
    cx = xx
    cy = yy
    cz = np.full_like(xx, z_coord)

    zx = np.zeros_like(cx)
    zy = np.zeros_like(cy)
    zz = np.zeros_like(cz)
    iteration = np.zeros(cx.shape, dtype=np.int32)
    mask = np.ones(cx.shape, dtype=bool)

    for step in range(MANDELBULB_MAX_ITER):
        if not np.any(mask):
            break
        r = np.sqrt(zx * zx + zy * zy + zz * zz)
        iteration[mask & (r >= 2.0)] = step
        mask &= r < 2.0
        if not np.any(mask):
            break

        theta = np.arctan2(np.sqrt(zx * zx + zy * zy), zz)
        phi = np.arctan2(zy, zx)
        rn = np.zeros_like(r)
        rn[mask] = np.power(r[mask], MANDELBULB_POWER)
        sin_theta = np.sin(MANDELBULB_POWER * theta)
        cos_theta = np.cos(MANDELBULB_POWER * theta)
        sin_phi = np.sin(MANDELBULB_POWER * phi)
        cos_phi = np.cos(MANDELBULB_POWER * phi)

        new_zx = rn * sin_theta * cos_phi + cx
        new_zy = rn * sin_theta * sin_phi + cy
        new_zz = rn * cos_theta + cz
        zx = np.where(mask, new_zx, zx)
        zy = np.where(mask, new_zy, zy)
        zz = np.where(mask, new_zz, zz)

    iteration[mask] = MANDELBULB_MAX_ITER

    return ((iteration * 16) % 4096).astype(np.uint16)


def volume_tczyx(
    size: int = 64,
    *,
    t: int = 1,
    c: int = 1,
    z: int = 1,
    pattern: Literal["mandelbulb", "indexed"] = "mandelbulb",
) -> np.ndarray:
    """Return a synthetic volume with shape ``[t, c, z, y, x]``."""
    if t < 1 or c < 1 or z < 1 or size < 1:
        raise ValueError("t, c, z, and size must be positive integers.")
    if pattern not in ("mandelbulb", "indexed"):
        raise ValueError(
            f"Unsupported pattern {pattern!r}; expected 'mandelbulb' or 'indexed'."
        )

    volume = np.zeros((t, c, z, size, size), dtype=np.uint16)
    for t_index in range(t):
        for c_index in range(c):
            for z_index in range(z):
                if pattern == "indexed":
                    plane = _indexed_plane(size, t=t_index, c=c_index, z=z_index)
                else:
                    plane = _mandelbulb_plane(size, z=z_index, z_count=z, t=t_index)
                volume[t_index, c_index, z_index] = plane
    return volume


def fractal_tczyx_image(size: int = 64) -> np.ndarray:
    """Return a Mandelbrot raster with shape ``[t, c, z, y, x]``."""
    return mandelbrot_plane(size).reshape(1, 1, 1, size, size)
