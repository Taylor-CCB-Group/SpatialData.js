from __future__ import annotations

import numpy as np


def mandelbrot_plane(size: int) -> np.ndarray:
    """
    Return a uint16 Mandelbrot escape-time plane as a basic visual quality test.

    This is a horribly slow and naive python implementation for now.

    In future we may expand
    - beyond image plane, volume/time dimensions for testing
    - synthesise images with qualities that better approximate microscopy
    - use webgpu or something to render the data (maybe do more of this scripting from js)
    """
    plane = np.zeros((size, size), dtype=np.uint16)
    for y in range(size):
        for x in range(size):
            cr = (x / size) * 3.5 - 2.5
            ci = (y / size) * 2.0 - 1.0
            zr = 0.0
            zi = 0.0
            iteration = 0
            while zr * zr + zi * zi <= 4.0 and iteration < 255:
                nr = zr * zr - zi * zi + cr
                zi = 2.0 * zr * zi + ci
                zr = nr
                iteration += 1
            plane[y, x] = (iteration * 16) % 4096
    return plane


def fractal_tczyx_image(size: int = 64) -> np.ndarray:
    """Return a Mandelbrot raster with shape ``[t, c, z, y, x]``."""
    return mandelbrot_plane(size).reshape(1, 1, 1, size, size)
