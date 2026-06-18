import numpy as np
import pytest

from synthetic_images import fractal_tczyx_image, mandelbrot_plane, volume_tczyx


def _reference_mandelbrot_plane(size: int) -> np.ndarray:
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


def test_mandelbrot_plane_shape_and_dtype() -> None:
    plane = mandelbrot_plane(32)
    assert plane.shape == (32, 32)
    assert plane.dtype == np.uint16


def test_mandelbrot_plane_matches_reference_implementation() -> None:
    size = 32
    assert np.array_equal(mandelbrot_plane(size), _reference_mandelbrot_plane(size))


def test_fractal_tczyx_image_shape() -> None:
    image = fractal_tczyx_image(64)
    assert image.shape == (1, 1, 1, 64, 64)


def test_volume_tczyx_indexed_shape_and_slice_distinctness() -> None:
    volume = volume_tczyx(8, t=2, c=1, z=3, pattern="indexed")
    assert volume.shape == (2, 1, 3, 8, 8)
    assert int(volume[0, 0, 0, 0, 0]) == 0
    assert int(volume[1, 0, 2, 0, 0]) == 1020
    assert int(volume[0, 0, 0, 0, 0]) != int(volume[1, 0, 2, 0, 0])


def test_volume_tczyx_mandelbulb_smoke() -> None:
    volume = volume_tczyx(16, t=2, c=1, z=3, pattern="mandelbulb")
    assert volume.shape == (2, 1, 3, 16, 16)
    assert volume.dtype == np.uint16
    assert np.all(volume <= 4095)
    assert not np.array_equal(volume[0, 0, 0], volume[0, 0, 2])
    assert not np.array_equal(volume[0, 0, 0], volume[1, 0, 0])


def test_volume_tczyx_rejects_non_positive_dimensions() -> None:
    with pytest.raises(ValueError):
        volume_tczyx(8, t=0, z=1)
