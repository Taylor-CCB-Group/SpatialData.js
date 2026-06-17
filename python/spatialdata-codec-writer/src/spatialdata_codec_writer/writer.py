from __future__ import annotations

import hashlib
import json
import shutil
from dataclasses import dataclass
from importlib import metadata
from pathlib import Path
from typing import Any, Literal

import imagecodecs
import numpy as np

CODEC_JPEG2K = "imagecodecs_jpeg2k"
CODEC_HTJ2K_OPENJPH = "experimental.openjph_htj2k"
# Legacy label for stores written before OpenJPH WASM became the supported encoder.
# The frontend still decodes this id; new writes use CODEC_HTJ2K_OPENJPH.
CODEC_HTJ2K_LEGACY = "experimental.imagecodecs_htj2k"
HTJ2K_CODECS = frozenset({CODEC_HTJ2K_OPENJPH, CODEC_HTJ2K_LEGACY})
HTJ2K_ENCODER = "openjph-wasm"

CodecName = Literal["imagecodecs_jpeg2k", "experimental.openjph_htj2k"]


def is_htj2k_codec(codec: str) -> bool:
    return codec in HTJ2K_CODECS


def htj2k_encode_available() -> bool:
    """Return whether the OpenJPH WASM HTJ2K encoder is available."""
    from .htj2k_encode import htj2k_encode_available as openjph_encode_available

    return openjph_encode_available()


@dataclass(frozen=True)
class WrittenFixture:
    store_path: Path
    manifest_path: Path
    manifest: dict[str, Any]


def _package_version(name: str) -> str | None:
    try:
        return metadata.version(name)
    except metadata.PackageNotFoundError:
        return None


def _default_image() -> np.ndarray:
    y, x = np.mgrid[0:64, 0:64]
    image = ((x * 17 + y * 31) % 4096).astype(np.uint16)
    return image.reshape(1, 1, 1, 64, 64)


def _mandelbrot_plane(size: int) -> np.ndarray:
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


def _fractal_image(size: int = 64) -> np.ndarray:
    return _mandelbrot_plane(size).reshape(1, 1, 1, size, size)


HTJ2K_QUALITY_SWEEP: tuple[dict[str, Any], ...] = (
    {"label": "lossless", "reversible": True, "quality": 0.0},
    {"label": "q0.001", "reversible": False, "quality": 0.001},
    {"label": "q0.002", "reversible": False, "quality": 0.002},
    {"label": "q0.005", "reversible": False, "quality": 0.005},
    {"label": "q0.01", "reversible": False, "quality": 0.01},
    {"label": "q0.05", "reversible": False, "quality": 0.05},
    {"label": "q0.1", "reversible": False, "quality": 0.1},
)


def _downsample2(image: np.ndarray) -> np.ndarray:
    return image[..., ::2, ::2].copy()


def _json_bytes(value: dict[str, Any]) -> bytes:
    return json.dumps(value, indent=2, sort_keys=True).encode("utf-8")


def _write_json(path: Path, value: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(_json_bytes(value))


def _sha256(data: bytes | bytearray) -> str:
    return hashlib.sha256(data).hexdigest()


def _chunk_grid(shape: tuple[int, ...], chunks: tuple[int, ...]) -> list[tuple[int, ...]]:
    ranges = [range((size + chunk - 1) // chunk) for size, chunk in zip(shape, chunks)]
    return [(t, c, z, y, x) for t in ranges[0] for c in ranges[1] for z in ranges[2] for y in ranges[3] for x in ranges[4]]


def _extract_chunk(image: np.ndarray, chunks: tuple[int, ...], coords: tuple[int, ...]) -> np.ndarray:
    slices = []
    for coord, chunk, size in zip(coords, chunks, image.shape):
        start = coord * chunk
        stop = min(start + chunk, size)
        slices.append(slice(start, stop))
    chunk_data = image[tuple(slices)]
    if chunk_data.shape == chunks:
        return chunk_data

    padded = np.zeros(chunks, dtype=image.dtype)
    padded_slices = tuple(slice(0, size) for size in chunk_data.shape)
    padded[padded_slices] = chunk_data
    return padded


def _encode_htj2k_plane(
    plane: np.ndarray, encode_options: dict[str, Any] | None = None
) -> bytes | bytearray:
    from .htj2k_encode import encode_htj2k_plane, htj2k_encode_available, openjph_encode_options

    if not htj2k_encode_available():
        raise RuntimeError(
            "HTJ2K encode is not available. Run from this repository with Node.js and "
            "@cornerstonejs/codec-openjph installed (pnpm install)."
        )
    reversible, quality = openjph_encode_options(encode_options or {})
    return encode_htj2k_plane(plane, reversible=reversible, quality=quality)


def _encode_chunk_2d(
    chunk: np.ndarray, codec: str, encode_options: dict[str, Any] | None = None
) -> bytes | bytearray:
    plane = np.asarray(chunk.reshape(chunk.shape[-2], chunk.shape[-1]))
    if codec == CODEC_JPEG2K:
        return imagecodecs.jpeg2k_encode(plane)
    if codec == CODEC_HTJ2K_OPENJPH:
        return _encode_htj2k_plane(plane, encode_options)
    raise ValueError(f"Unsupported codec: {codec}")


def _decode_htj2k_plane(encoded: bytes | bytearray) -> np.ndarray:
    """Decode an HTJ2K plane for validation (OpenJPH WASM or native imagecodecs)."""
    htj2k = getattr(imagecodecs, "HTJ2K", None)
    if htj2k is not None and getattr(htj2k, "available", False):
        decoder = getattr(imagecodecs, "htj2k_decode", None)
        if decoder is not None:
            return decoder(encoded)
    return imagecodecs.jpeg2k_decode(encoded)


def _decode_chunk_2d(encoded: bytes | bytearray, codec: str) -> np.ndarray:
    if codec == CODEC_JPEG2K:
        return imagecodecs.jpeg2k_decode(encoded)
    if is_htj2k_codec(codec):
        return _decode_htj2k_plane(encoded)
    raise ValueError(f"Unsupported codec: {codec}")


def _array_metadata(shape: tuple[int, ...], chunks: tuple[int, ...], dtype: np.dtype, codec: str) -> dict[str, Any]:
    return {
        "zarr_format": 3,
        "node_type": "array",
        "shape": list(shape),
        "data_type": np.dtype(dtype).name,
        "chunk_grid": {
            "name": "regular",
            "configuration": {"chunk_shape": list(chunks)},
        },
        "chunk_key_encoding": {
            "name": "default",
            "configuration": {"separator": "/"},
        },
        "fill_value": 0,
        "codecs": [{"name": codec, "configuration": {}}],
        "attributes": {},
        "dimension_names": ["t", "c", "z", "y", "x"],
    }


def _group_metadata(attributes: dict[str, Any] | None = None) -> dict[str, Any]:
    return {
        "zarr_format": 3,
        "node_type": "group",
        "attributes": attributes or {},
    }


def _image_attrs(datasets: list[dict[str, Any]], image_key: str) -> dict[str, Any]:
    return {
        "ome": {
            "multiscales": [
                {
                    "name": image_key,
                    "axes": [
                        {"name": "t", "type": "time"},
                        {"name": "c", "type": "channel"},
                        {"name": "z", "type": "space", "unit": "micrometer"},
                        {"name": "y", "type": "space", "unit": "micrometer"},
                        {"name": "x", "type": "space", "unit": "micrometer"},
                    ],
                    "datasets": datasets,
                    "coordinateTransformations": [
                        {
                            "type": "identity",
                            "output": {
                                "name": "global",
                                "axes": [
                                    {"name": "z", "type": "space", "unit": "micrometer"},
                                    {"name": "y", "type": "space", "unit": "micrometer"},
                                    {"name": "x", "type": "space", "unit": "micrometer"},
                                ],
                            },
                        }
                    ],
                }
            ],
            "omero": {
                "name": image_key,
                "channels": [
                    {
                        "label": "channel_0",
                        "color": "FFFFFF",
                        "window": {"min": 0, "max": 4095, "start": 0, "end": 4095},
                        "active": True,
                    }
                ],
            },
        },
        "spatialdata_attrs": {"version": "0.7.2"},
    }


def _base_image_element(image: Any) -> Any:
    children = getattr(image, "children", None)
    if children is None or "scale0" not in children:
        return image

    scale0 = children["scale0"]
    dataset = getattr(scale0, "ds", None)
    if dataset is None:
        return scale0
    if "image" in dataset:
        return dataset["image"]

    data_vars = getattr(dataset, "data_vars", {})
    for name in data_vars:
        return dataset[name]
    raise ValueError("Could not find an image variable in SpatialData multiscale image scale0")


def image_to_tczyx(image: Any, dims: tuple[str, ...] | list[str] | None = None) -> np.ndarray:
    """Return an image as a NumPy array with shape ``[t, c, z, y, x]``.

    ``image`` can be a NumPy/Dask array, an xarray ``DataArray``, or a
    SpatialData image element. When dimension names are available, this helper
    uses them; otherwise it accepts common image shapes: ``yx``, ``cyx``,
    ``czyx``, and already-normalized ``tczyx``.
    """

    image = _base_image_element(image)

    if dims is None:
        maybe_dims = getattr(image, "dims", None)
        dims = tuple(str(dim) for dim in maybe_dims) if maybe_dims is not None else None

    data = getattr(image, "data", image)
    if hasattr(data, "compute"):
        data = data.compute()
    array = np.asarray(data)

    if dims is not None:
        normalized_dims = tuple(str(dim) for dim in dims)
        if len(normalized_dims) != array.ndim:
            raise ValueError(f"dims length {len(normalized_dims)} does not match array ndim {array.ndim}")
        supported = ("t", "c", "z", "y", "x")
        unsupported = [dim for dim in normalized_dims if dim not in supported]
        if unsupported:
            raise ValueError(f"Unsupported image dimensions: {unsupported}")
        if "y" not in normalized_dims or "x" not in normalized_dims:
            raise ValueError("Image dimensions must include 'y' and 'x'.")

        present = [dim for dim in supported if dim in normalized_dims]
        array = np.transpose(array, [normalized_dims.index(dim) for dim in present])
        for axis_index, dim in enumerate(supported):
            if dim not in present:
                array = np.expand_dims(array, axis=axis_index)
        return np.asarray(array)

    if array.ndim == 2:
        return array.reshape(1, 1, 1, *array.shape)
    if array.ndim == 3:
        return array.reshape(1, array.shape[0], 1, array.shape[1], array.shape[2])
    if array.ndim == 4:
        return array.reshape(1, *array.shape)
    if array.ndim == 5:
        return array
    raise ValueError("image must have shape yx, cyx, czyx, or tczyx when dims are not provided")


def _write_array_chunks(
    store_path: Path,
    array_path: str,
    image: np.ndarray,
    chunks: tuple[int, ...],
    codec: str,
) -> list[dict[str, Any]]:
    refs: list[dict[str, Any]] = []
    for coords in _chunk_grid(image.shape, chunks):
        chunk = _extract_chunk(image, chunks, coords)
        encoded = _encode_chunk_2d(chunk, codec)
        chunk_rel = f"{array_path}/c/" + "/".join(str(c) for c in coords)
        chunk_path = store_path / chunk_rel
        chunk_path.parent.mkdir(parents=True, exist_ok=True)
        chunk_path.write_bytes(encoded)

        decoded = _decode_chunk_2d(encoded, codec)
        expected_plane = chunk.reshape(chunk.shape[-2], chunk.shape[-1])
        if not np.array_equal(decoded.reshape(expected_plane.shape), expected_plane):
            raise RuntimeError(f"Codec self-validation failed for chunk {coords}")

        refs.append(
            {
                "coords": list(coords),
                "path": chunk_rel,
                "encoded_sha256": _sha256(encoded),
                "decoded_sha256": _sha256(expected_plane.tobytes()),
                "samples": [
                    int(expected_plane[0, 0]),
                    int(expected_plane[0, min(1, expected_plane.shape[1] - 1)]),
                    int(expected_plane[min(1, expected_plane.shape[0] - 1), 0]),
                ],
            }
        )
    return refs


def write_codec_spatialdata(
    path: str | Path,
    *,
    codec: CodecName = CODEC_JPEG2K,
    image: Any | None = None,
    image_key: str = "codec_image",
    chunks: tuple[int, int, int, int, int] = (1, 1, 1, 32, 32),
    multiscale: bool = True,
    overwrite: bool = False,
) -> WrittenFixture:
    store_path = Path(path)
    if store_path.exists():
        if not overwrite:
            raise FileExistsError(store_path)
        shutil.rmtree(store_path)
    store_path.mkdir(parents=True)

    base = image_to_tczyx(image if image is not None else _default_image())
    if base.ndim != 5:
        raise ValueError("image must have shape [t, c, z, y, x]")
    if len(chunks) != 5:
        raise ValueError("chunks must have shape [t, c, z, y, x]")
    if chunks[:3] != (1, 1, 1):
        raise ValueError("v1 codec fixtures require chunks beginning with (1, 1, 1)")

    levels = [base]
    if multiscale:
        levels.append(_downsample2(base))

    image_attrs = _image_attrs(
        [
            {
                "path": str(level_index),
                "coordinateTransformations": [
                    {"type": "scale", "scale": [1, 1, 1, 2**level_index, 2**level_index]}
                ],
            }
            for level_index in range(len(levels))
        ],
        image_key,
    )

    metadata: dict[str, Any] = {
        "images": _group_metadata(),
        f"images/{image_key}": _group_metadata(image_attrs),
    }

    chunk_refs: list[dict[str, Any]] = []
    for level_index, level in enumerate(levels):
        array_path = f"images/{image_key}/{level_index}"
        metadata[array_path] = _array_metadata(level.shape, chunks, level.dtype, codec)
        chunk_refs.extend(_write_array_chunks(store_path, array_path, level, chunks, codec))

    root_metadata = {
        "zarr_format": 3,
        "node_type": "group",
        "attributes": {"spatialdata_attrs": {"version": "0.7.2"}},
        "consolidated_metadata": {
            "kind": "inline",
            "must_understand": False,
            "metadata": metadata,
        },
    }
    _write_json(store_path / "zarr.json", root_metadata)
    for node_path, node_metadata in metadata.items():
        _write_json(store_path / node_path / "zarr.json", node_metadata)

    manifest = {
        "format": "spatialdata-codec-fixture/v1",
        "codec": codec,
        "store": store_path.name,
        "image_path": f"images/{image_key}",
        "shape": list(base.shape),
        "dtype": str(base.dtype),
        "chunks": list(chunks),
        "multiscale_levels": len(levels),
        "packages": {
            "imagecodecs": _package_version("imagecodecs"),
            "numpy": _package_version("numpy"),
            "spatialdata": _package_version("spatialdata"),
            "zarr": _package_version("zarr"),
        },
        "chunks_checked": chunk_refs[:4],
    }
    if is_htj2k_codec(codec):
        manifest["encoder"] = HTJ2K_ENCODER
    manifest_path = store_path.with_suffix(".manifest.json")
    _write_json(manifest_path, manifest)

    try:
        import spatialdata as sd

        sd.read_zarr(store_path)
    except Exception as exc:  # pragma: no cover - diagnostic metadata is enough for fixture use.
        manifest["spatialdata_read_warning"] = str(exc)
        _write_json(manifest_path, manifest)

    return WrittenFixture(store_path=store_path, manifest_path=manifest_path, manifest=manifest)


def write_codec_spatialdata_image(
    path: str | Path,
    spatialdata_or_path: Any,
    *,
    image_key: str,
    codec: CodecName = CODEC_JPEG2K,
    chunks: tuple[int, int, int, int, int] = (1, 1, 1, 32, 32),
    multiscale: bool = True,
    overwrite: bool = False,
) -> WrittenFixture:
    """Write one image from an existing SpatialData object/path with a codec.

    This is a focused transcoder for image-reader fixtures and experiments. It
    writes a new store containing the selected image under ``images/<image_key>``;
    it does not yet preserve tables, shapes, points, labels, or arbitrary source
    metadata from the input SpatialData object.
    """

    source = spatialdata_or_path
    if isinstance(spatialdata_or_path, str | Path):
        import spatialdata as sd

        source = sd.read_zarr(spatialdata_or_path)

    images = getattr(source, "images", None)
    if images is None or image_key not in images:
        raise KeyError(f"SpatialData object does not contain image {image_key!r}")

    return write_codec_spatialdata(
        path,
        codec=codec,
        image=image_to_tczyx(images[image_key]),
        image_key=image_key,
        chunks=chunks,
        multiscale=multiscale,
        overwrite=overwrite,
    )


def write_jpeg2k_fixture(path: str | Path, *, overwrite: bool = False) -> WrittenFixture:
    return write_codec_spatialdata(path, codec=CODEC_JPEG2K, overwrite=overwrite)


def write_htj2k_fixture(path: str | Path, *, overwrite: bool = False) -> WrittenFixture:
    return write_codec_spatialdata(
        path,
        codec=CODEC_HTJ2K_OPENJPH,
        image=_fractal_image(),
        overwrite=overwrite,
    )


def _plane_error_metrics(source: np.ndarray, decoded: np.ndarray) -> dict[str, float]:
    diff = decoded.astype(np.float64) - source.astype(np.float64)
    mse = float(np.mean(diff * diff))
    return {
        "rmse": float(np.sqrt(mse)),
        "max_abs_error": float(np.max(np.abs(diff))),
    }


def write_htj2k_quality_sweep_manifest(path: str | Path) -> Path:
    """Encode a Mandelbrot plane at several qualities and write a benchmark manifest."""
    from .htj2k_encode import encode_htj2k_plane, htj2k_encode_available

    if not htj2k_encode_available():
        raise RuntimeError("OpenJPH WASM HTJ2K encoder is not available.")

    plane = _mandelbrot_plane(64)
    raw_bytes = int(plane.nbytes)
    qualities: list[dict[str, Any]] = []
    for entry in HTJ2K_QUALITY_SWEEP:
        encoded = encode_htj2k_plane(
            plane,
            reversible=bool(entry["reversible"]),
            quality=float(entry["quality"]),
        )
        decoded = _decode_htj2k_plane(encoded).reshape(plane.shape)
        metrics = _plane_error_metrics(plane, decoded)
        qualities.append(
            {
                **entry,
                "encoded_bytes": len(encoded),
                "compression_ratio": raw_bytes / len(encoded),
                **metrics,
            }
        )

    manifest_path = Path(path)
    manifest_path.parent.mkdir(parents=True, exist_ok=True)
    _write_json(
        manifest_path,
        {
            "format": "spatialdata-htj2k-quality-sweep/v1",
            "encoder": HTJ2K_ENCODER,
            "api": "HTJ2KEncoder.setQuality(reversible, quality)",
            "quality_note": (
                "OpenJPH WASM quality is a quantization factor, not JP2K-style 0-100. "
                "Lower values preserve more detail (larger output). Integer values above "
                "~15 with irreversible=true produce degenerate minimum-bitrate output."
            ),
            "image": {"kind": "mandelbrot", "shape": list(plane.shape), "dtype": str(plane.dtype)},
            "raw_bytes": raw_bytes,
            "qualities": qualities,
        },
    )
    return manifest_path
