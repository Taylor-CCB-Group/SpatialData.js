import numpy as np

from synthetic_images import fractal_tczyx_image, mandelbrot_plane


def test_mandelbrot_plane_shape_and_dtype() -> None:
    plane = mandelbrot_plane(32)
    assert plane.shape == (32, 32)
    assert plane.dtype == np.uint16


def test_fractal_tczyx_image_shape() -> None:
    image = fractal_tczyx_image(64)
    assert image.shape == (1, 1, 1, 64, 64)
