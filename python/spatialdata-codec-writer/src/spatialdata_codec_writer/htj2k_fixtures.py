from __future__ import annotations

from pathlib import Path
from typing import Any

import numpy as np

from .synthetic_images import fractal_tczyx_image, mandelbrot_plane
from .writer import (
    CODEC_HTJ2K_OPENJPH,
    CodecImageWrite,
    HTJ2K_ENCODER,
    WrittenFixture,
    _decode_htj2k_plane,
    _write_json,
    write_codec_spatialdata,
    write_codec_spatialdata_images,
)

HTJ2K_ENCODE_DEMO_STORE = "htj2k-demo.zarr"

HTJ2K_QUALITY_SWEEP: tuple[dict[str, Any], ...] = (
    {"label": "lossless", "reversible": True, "quality": 0.0},
    {"label": "q0.0001", "reversible": False, "quality": 0.0001},
    {"label": "q0.0002", "reversible": False, "quality": 0.0002},
    {"label": "q0.0005", "reversible": False, "quality": 0.0005},
    {"label": "q0.001", "reversible": False, "quality": 0.001},
    {"label": "q0.002", "reversible": False, "quality": 0.002},
    {"label": "q0.005", "reversible": False, "quality": 0.005},
    {"label": "q0.01", "reversible": False, "quality": 0.01},
    {"label": "q0.05", "reversible": False, "quality": 0.05},
    {"label": "q0.1", "reversible": False, "quality": 0.1},
)

HTJ2K_ENCODE_DEMO_SIZE = 512
HTJ2K_ENCODE_DEMO_CHUNKS: tuple[int, int, int, int, int] = (1, 1, 1, 64, 64)
HTJ2K_ENCODE_DEMO_PRESETS: tuple[dict[str, Any], ...] = (
    {"label": "lossless", "suffix": "lossless", "encode_options": {"reversible": True}},
    {
        "label": "balanced (q=0.0002)",
        "suffix": "balanced",
        "encode_options": {"reversible": False, "quality": 0.0002},
    },
    {
        "label": "small (q=0.001)",
        "suffix": "small",
        "encode_options": {"reversible": False, "quality": 0.001},
    },
)


def htj2k_encode_demo_image_key(suffix: str) -> str:
    return f"mandelbrot_{suffix}"


def _count_image_encoded_bytes(store_path: Path, image_key: str) -> int:
    encoded_bytes = 0
    image_root = store_path / "images" / image_key
    for level_dir in image_root.iterdir():
        if not level_dir.is_dir():
            continue
        c_dir = level_dir / "c"
        if not c_dir.is_dir():
            continue
        for chunk_path in c_dir.rglob("*"):
            if chunk_path.is_file():
                encoded_bytes += chunk_path.stat().st_size
    return encoded_bytes


def write_htj2k_fixture(path: str | Path, *, overwrite: bool = False) -> WrittenFixture:
    return write_codec_spatialdata(
        path,
        codec=CODEC_HTJ2K_OPENJPH,
        image=fractal_tczyx_image(),
        overwrite=overwrite,
    )


def write_htj2k_encode_demo_fixtures(path: str | Path, *, overwrite: bool = False) -> Path:
    """Write one multiscale Mandelbrot store with several HTJ2K quality presets."""
    output_dir = Path(path)
    output_dir.mkdir(parents=True, exist_ok=True)
    store_path = output_dir / HTJ2K_ENCODE_DEMO_STORE
    image = fractal_tczyx_image(HTJ2K_ENCODE_DEMO_SIZE)

    image_writes = [
        CodecImageWrite(
            image_key=htj2k_encode_demo_image_key(str(preset["suffix"])),
            image=image,
            encode_options=dict(preset["encode_options"]),
        )
        for preset in HTJ2K_ENCODE_DEMO_PRESETS
    ]
    written = write_codec_spatialdata_images(
        store_path,
        images=image_writes,
        codec=CODEC_HTJ2K_OPENJPH,
        chunks=HTJ2K_ENCODE_DEMO_CHUNKS,
        multiscale=True,
        overwrite=overwrite,
    )

    variants: list[dict[str, Any]] = []
    for preset, spec in zip(HTJ2K_ENCODE_DEMO_PRESETS, image_writes, strict=True):
        suffix = str(preset["suffix"])
        encode_options = dict(preset["encode_options"])
        image_key = spec.image_key
        image_manifest = next(
            entry for entry in written.manifest["images"] if entry["image_key"] == image_key
        )
        encoded_bytes = _count_image_encoded_bytes(store_path, image_key)
        variants.append(
            {
                "label": preset["label"],
                "suffix": suffix,
                "image_key": image_key,
                "image_path": image_manifest["image_path"],
                "lossless": image_manifest.get("lossless", False),
                "encode_options": encode_options,
                "encoded_bytes": encoded_bytes,
                "compression_ratio": int(image.nbytes) / encoded_bytes if encoded_bytes else None,
            }
        )

    manifest_path = output_dir / "htj2k-encode-demo.manifest.json"
    _write_json(
        manifest_path,
        {
            "format": "spatialdata-htj2k-encode-demo/v2",
            "encoder": HTJ2K_ENCODER,
            "store": HTJ2K_ENCODE_DEMO_STORE,
            "image": {
                "kind": "mandelbrot",
                "shape": list(image.shape),
                "dtype": str(image.dtype),
            },
            "chunks": list(HTJ2K_ENCODE_DEMO_CHUNKS),
            "multiscale_levels": written.manifest["multiscale_levels"],
            "variants": variants,
        },
    )
    return manifest_path


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

    plane = mandelbrot_plane(64)
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
