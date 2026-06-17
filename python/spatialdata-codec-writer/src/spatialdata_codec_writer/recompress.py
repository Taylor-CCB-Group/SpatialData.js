from __future__ import annotations

import json
import shutil
import tempfile
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Literal

import numpy as np
import zarr
from zarr.codecs import BloscCodec, BloscShuffle

from .codecs import (
    CODEC_HTJ2K_OPENJPH,
    CODEC_JPEG2K,
    HTJ2K_ENCODER,
    chunk_grid,
    chunk_slices,
    decode_image_plane,
    encode_image_plane,
    is_htj2k_codec,
    package_version,
    pad_chunk,
    sha256,
    write_json,
)
from .htj2k_encode import configure_encoder_pool, htj2k_encode_available

ImagePreset = Literal["lossless", "balanced", "small"]
ChunkSpec = Literal["auto"] | tuple[int, ...] | list[int]

SUPPORTED_IMAGE_CODECS = frozenset({CODEC_JPEG2K, CODEC_HTJ2K_OPENJPH})

SUPPORTED_BROWSER_JP2K_DTYPES = {
    np.dtype("uint8"),
    np.dtype("int8"),
    np.dtype("uint16"),
    np.dtype("int16"),
}

JP2K_PRESETS: dict[ImagePreset, dict[str, Any]] = {
    "lossless": {"reversible": True},
    "balanced": {"reversible": False, "level": 100},
    "small": {"reversible": False, "level": 75},
}

HTJ2K_PRESETS: dict[ImagePreset, dict[str, Any]] = {
    "lossless": {"reversible": True},
    "balanced": {"reversible": False, "quality": 0.0002},
    "small": {"reversible": False, "quality": 0.001},
}


@dataclass(frozen=True)
class RecompressedSpatialData:
    store_path: Path
    manifest_path: Path | None
    manifest: dict[str, Any]


def _read_json(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text())


def _load_config(config: str | Path | dict[str, Any] | None) -> dict[str, Any]:
    if config is None:
        return {}
    if isinstance(config, dict):
        return json.loads(json.dumps(config))
    return _read_json(Path(config))


def _default_config() -> dict[str, Any]:
    return {
        "default_image": {
            "codec": CODEC_JPEG2K,
            "preset": "lossless",
            "chunks": "auto",
        },
        "images": {},
        "default_labels": {
            "codec": "blosc",
            "clevel": 5,
        },
        "labels": {},
    }


def _deep_merge(base: dict[str, Any], override: dict[str, Any]) -> dict[str, Any]:
    out = dict(base)
    for key, value in override.items():
        if isinstance(value, dict) and isinstance(out.get(key), dict):
            out[key] = _deep_merge(out[key], value)
        else:
            out[key] = value
    return out


def _apply_image_shortcuts(
    image_cfg: dict[str, Any],
    *,
    codec: str | None = None,
    preset: ImagePreset | None = None,
    chunks: ChunkSpec | None = None,
    quality: float | None = None,
    reversible: bool | None = None,
) -> dict[str, Any]:
    out = dict(image_cfg)
    if codec is not None:
        out["codec"] = codec
    if preset is not None:
        out["preset"] = preset
    if chunks is not None:
        out["chunks"] = chunks
    if quality is not None:
        out["quality"] = quality
    if reversible is not None:
        out["reversible"] = reversible
    return out


def resolve_recompression_config(
    config: str | Path | dict[str, Any] | None = None,
    *,
    image_key: str | None = None,
    codec: str | None = None,
    preset: ImagePreset | None = None,
    chunks: ChunkSpec | None = None,
    quality: float | None = None,
    reversible: bool | None = None,
) -> dict[str, Any]:
    """Return normalized recompression config after CLI shortcut expansion.

    When *image_key* is set, shortcut flags apply to that image only. Otherwise
    they update ``default_image`` and apply to every image in the store.
    """

    resolved = _deep_merge(_default_config(), _load_config(config))
    shortcuts = _apply_image_shortcuts(
        {},
        codec=codec,
        preset=preset,
        chunks=chunks,
        quality=quality,
        reversible=reversible,
    )
    if image_key is not None:
        image_cfg = _apply_image_shortcuts(
            dict(resolved.get("images", {}).get(image_key, {})),
            codec=codec,
            preset=preset,
            chunks=chunks,
            quality=quality,
            reversible=reversible,
        )
        resolved.setdefault("images", {})[image_key] = image_cfg
    elif shortcuts:
        resolved["default_image"] = _deep_merge(resolved.get("default_image", {}), shortcuts)
    return resolved


def _list_raster_keys(store_path: Path, kind: Literal["images", "labels"]) -> list[str]:
    root = store_path / kind
    if not root.exists():
        return []
    return sorted(path.name for path in root.iterdir() if path.is_dir())


def _attrs_from_node(path: Path) -> dict[str, Any]:
    meta_path = path / "zarr.json"
    if not meta_path.exists():
        return {}
    return _read_json(meta_path).get("attributes", {})


def _datasets_from_raster_group(path: Path) -> list[str]:
    attrs = _attrs_from_node(path)
    ome_attrs = attrs.get("ome", attrs)
    if isinstance(ome_attrs, dict):
        multiscales = ome_attrs.get("multiscales")
        datasets = multiscales[0].get("datasets") if multiscales else None
        if datasets:
            return [str(dataset["path"]) for dataset in datasets if "path" in dataset]

    levels = []
    for child in path.iterdir() if path.exists() else []:
        if child.is_dir() and (child / "zarr.json").exists():
            meta = _read_json(child / "zarr.json")
            if meta.get("node_type") == "array":
                levels.append(child.name)
    return sorted(levels, key=lambda value: (not value.isdigit(), value))


def _auto_image_chunks(shape: tuple[int, ...], max_spatial: int = 1024) -> tuple[int, ...]:
    if len(shape) < 2:
        raise ValueError(f"Expected at least 2D raster shape, got {shape}")
    return (*([1] * (len(shape) - 2)), min(max_spatial, shape[-2]), min(max_spatial, shape[-1]))


def _normalize_chunks(spec: ChunkSpec, shape: tuple[int, ...], *, image: bool) -> tuple[int, ...]:
    if spec == "auto":
        return _auto_image_chunks(shape) if image else tuple(min(size, 1024) for size in shape)
    chunks = tuple(int(value) for value in spec)
    if len(chunks) != len(shape):
        raise ValueError(f"Chunk spec {chunks} does not match raster shape {shape}")
    return chunks


def _validate_browser_image_codec_dtype(dtype: np.dtype, raster_path: str) -> None:
    if dtype not in SUPPORTED_BROWSER_JP2K_DTYPES:
        supported = ", ".join(
            str(dtype) for dtype in sorted(SUPPORTED_BROWSER_JP2K_DTYPES, key=str)
        )
        raise TypeError(
            f"Browser image codecs support only <=16-bit integer dtypes ({supported}); "
            f"{raster_path} has dtype {dtype}. Use Blosc for labels or skip this raster."
        )


def _validate_browser_image_codec_chunks(chunks: tuple[int, ...], raster_path: str) -> None:
    if len(chunks) < 2:
        raise ValueError(f"{raster_path} must be at least 2D")
    non_spatial = chunks[:-2]
    if any(chunk != 1 for chunk in non_spatial):
        raise ValueError(
            f"{raster_path} image codec chunks must have singleton non-spatial axes; got {chunks}."
        )


def _resolve_image_codec(config: dict[str, Any], raster_key: str) -> str:
    codec = config.get("codec", CODEC_JPEG2K)
    if codec not in SUPPORTED_IMAGE_CODECS:
        supported = ", ".join(sorted(SUPPORTED_IMAGE_CODECS))
        raise ValueError(
            f"Unsupported image codec for {raster_key!r}: {codec!r}; expected one of {supported}"
        )
    if codec == CODEC_HTJ2K_OPENJPH and not htj2k_encode_available():
        raise RuntimeError(
            f"HTJ2K recompression requested for {raster_key!r}, but the OpenJPH WASM encoder "
            "is not available. Install spatialdata-codec-writer and ensure Node.js is on PATH."
        )
    return codec


def _array_metadata_from_source(
    source_meta: dict[str, Any],
    *,
    chunks: tuple[int, ...],
    codecs: list[dict[str, Any]],
) -> dict[str, Any]:
    meta = dict(source_meta)
    meta["chunk_grid"] = {
        "name": "regular",
        "configuration": {"chunk_shape": list(chunks)},
    }
    meta["chunk_key_encoding"] = {
        "name": "default",
        "configuration": {"separator": "/"},
    }
    meta["codecs"] = codecs
    return meta


def _preset_encode_options(config: dict[str, Any], *, codec: str) -> dict[str, Any]:
    presets = HTJ2K_PRESETS if codec == CODEC_HTJ2K_OPENJPH else JP2K_PRESETS
    preset_family = "HTJ2K" if codec == CODEC_HTJ2K_OPENJPH else "JP2K"
    encode_options = dict(config.get("encode_options", {}))

    preset = config.get("preset")
    has_explicit_quality = "quality" in config or "quality" in encode_options
    if preset is not None:
        if preset not in presets:
            raise ValueError(
                f"Unknown {preset_family} preset {preset!r}; expected one of {sorted(presets)}"
            )
        options = dict(presets[preset])
    elif has_explicit_quality and codec == CODEC_HTJ2K_OPENJPH:
        options = {}
    else:
        options = dict(presets["lossless"])

    options.update(encode_options)
    for key in ("level", "quality", "reversible", "codecformat", "numthreads"):
        if key in config:
            options[key] = config[key]

    explicit_lossless = config.get("reversible") is True or encode_options.get("reversible") is True
    if options.get("quality") is not None and not explicit_lossless:
        options["reversible"] = False

    return options


def _sibling_image_label(image_config: dict[str, Any]) -> str:
    """Return a sibling suffix label from preset and/or explicit encode settings."""
    encode_options = image_config.get("encode_options", {})
    quality = image_config.get("quality", encode_options.get("quality"))
    if quality is not None and image_config.get("reversible") is not True:
        return f"q{float(quality):g}"
    preset = image_config.get("preset", "lossless")
    return str(preset)


def _sample_values(plane: np.ndarray) -> list[int | float]:
    values = [
        plane[0, 0],
        plane[0, min(1, plane.shape[1] - 1)],
        plane[min(1, plane.shape[0] - 1), 0],
    ]
    return [value.item() if hasattr(value, "item") else value for value in values]


def _encode_chunk_task(
    plane: np.ndarray, codec: str, encode_options: dict[str, Any]
) -> bytes | bytearray:
    return encode_image_plane(plane, codec, encode_options)


def _recompress_image_array(
    *,
    source_array_path: Path,
    dest_array_path: Path,
    raster_path: str,
    config: dict[str, Any],
    workers: int,
) -> dict[str, Any]:
    source_meta = _read_json(source_array_path / "zarr.json")
    source_array = zarr.open_array(str(source_array_path), mode="r")
    shape = tuple(int(value) for value in source_array.shape)
    dtype = np.dtype(source_array.dtype)
    codec = _resolve_image_codec(config, raster_path)
    _validate_browser_image_codec_dtype(dtype, raster_path)

    chunks = _normalize_chunks(config.get("chunks", "auto"), shape, image=True)
    _validate_browser_image_codec_chunks(chunks, raster_path)
    encode_options = _preset_encode_options(config, codec=codec)
    is_lossless = bool(encode_options.get("reversible", False))

    if dest_array_path.exists():
        shutil.rmtree(dest_array_path)
    (dest_array_path / "c").mkdir(parents=True)
    write_json(
        dest_array_path / "zarr.json",
        _array_metadata_from_source(
            source_meta,
            chunks=chunks,
            codecs=[{"name": codec, "configuration": {}}],
        ),
    )

    chunk_jobs: list[tuple[tuple[int, ...], np.ndarray]] = []
    for coords in chunk_grid(shape, chunks):
        selection = chunk_slices(shape, chunks, coords)
        chunk = pad_chunk(np.asarray(source_array[selection]), chunks)
        plane = chunk.reshape(chunk.shape[-2], chunk.shape[-1])
        chunk_jobs.append((coords, plane))

    encoded_by_coords: dict[tuple[int, ...], tuple[bytes | bytearray, np.ndarray]] = {}
    encoded_bytes = 0

    if workers <= 1 or len(chunk_jobs) <= 1:
        for coords, plane in chunk_jobs:
            encoded = _encode_chunk_task(plane, codec, encode_options)
            encoded_bytes += len(encoded)
            encoded_by_coords[coords] = (encoded, plane)
    else:
        with ThreadPoolExecutor(max_workers=workers) as executor:
            future_to_coords = {
                executor.submit(_encode_chunk_task, plane, codec, encode_options): coords
                for coords, plane in chunk_jobs
            }
            for future in as_completed(future_to_coords):
                coords = future_to_coords[future]
                plane = next(plane for c, plane in chunk_jobs if c == coords)
                encoded = future.result()
                encoded_bytes += len(encoded)
                encoded_by_coords[coords] = (encoded, plane)

    chunks_checked: list[dict[str, Any]] = []
    chunk_count = 0
    for coords, plane in chunk_jobs:
        encoded, plane = encoded_by_coords[coords]
        chunk_count += 1
        chunk_rel = Path("c").joinpath(*(str(coord) for coord in coords))
        chunk_path = dest_array_path / chunk_rel
        chunk_path.parent.mkdir(parents=True, exist_ok=True)
        chunk_path.write_bytes(encoded)

        if len(chunks_checked) < 4:
            decoded = decode_image_plane(encoded, codec)
            decoded_plane = decoded.reshape(plane.shape)
            if is_lossless and not np.array_equal(decoded_plane, plane):
                raise RuntimeError(
                    f"Lossless {codec} self-validation failed for {raster_path} chunk {coords}"
                )
            chunks_checked.append(
                {
                    "coords": list(coords),
                    "encoded_sha256": sha256(encoded),
                    "decoded_sha256": sha256(decoded_plane.tobytes()),
                    "source_sha256": sha256(plane.tobytes()),
                    "samples": _sample_values(decoded_plane),
                }
            )

    report: dict[str, Any] = {
        "path": raster_path,
        "codec": codec,
        "preset": config.get("preset", "lossless"),
        "encode_options": encode_options,
        "shape": list(shape),
        "dtype": str(dtype),
        "chunks": list(chunks),
        "chunk_count": chunk_count,
        "encoded_bytes": encoded_bytes,
        "lossless": is_lossless,
        "chunks_checked": chunks_checked,
    }
    if is_htj2k_codec(codec):
        report["encoder"] = HTJ2K_ENCODER
    return report


def _blosc_codec(dtype: np.dtype, clevel: int) -> BloscCodec:
    if dtype.kind not in ("u", "i"):
        raise TypeError(f"Labels must be integer dtype for Blosc label compression, got {dtype}")
    return BloscCodec(
        cname="zstd",
        clevel=clevel,
        shuffle=BloscShuffle.shuffle,
        typesize=max(1, dtype.itemsize),
    )


def _recompress_label_array(
    *,
    source_array_path: Path,
    dest_array_path: Path,
    raster_path: str,
    config: dict[str, Any],
) -> dict[str, Any]:
    source_meta = _read_json(source_array_path / "zarr.json")
    source_array = zarr.open_array(str(source_array_path), mode="r")
    shape = tuple(int(value) for value in source_array.shape)
    dtype = np.dtype(source_array.dtype)
    chunks = _normalize_chunks(config.get("chunks", source_array.chunks), shape, image=False)
    codec = _blosc_codec(dtype, int(config.get("clevel", 5)))

    if dest_array_path.exists():
        shutil.rmtree(dest_array_path)
    dest_array_path.mkdir(parents=True)
    dest_array = zarr.create_array(
        store=str(dest_array_path),
        shape=shape,
        chunks=chunks,
        dtype=dtype,
        compressors=[codec],
        fill_value=source_meta.get("fill_value", 0),
        attributes=source_meta.get("attributes", {}),
        dimension_names=source_meta.get("dimension_names"),
        zarr_format=3,
        overwrite=True,
    )

    chunk_count = 0
    for coords in chunk_grid(shape, chunks):
        selection = chunk_slices(shape, chunks, coords)
        dest_array[selection] = source_array[selection]
        chunk_count += 1

    meta = _read_json(dest_array_path / "zarr.json")
    return {
        "path": raster_path,
        "codec": "blosc",
        "shape": list(shape),
        "dtype": str(dtype),
        "chunks": list(chunks),
        "chunk_count": chunk_count,
        "codecs": meta.get("codecs", []),
    }


def _collect_consolidated_metadata(store_path: Path) -> dict[str, Any]:
    metadata: dict[str, Any] = {}
    for meta_path in store_path.rglob("zarr.json"):
        if meta_path == store_path / "zarr.json":
            continue
        rel = meta_path.parent.relative_to(store_path).as_posix()
        metadata[rel] = _read_json(meta_path)
    return metadata


def _refresh_consolidated_metadata(store_path: Path) -> None:
    root_path = store_path / "zarr.json"
    root_meta = _read_json(root_path)
    root_meta["consolidated_metadata"] = {
        "kind": "inline",
        "must_understand": False,
        "metadata": _collect_consolidated_metadata(store_path),
    }
    write_json(root_path, root_meta)


def _prepare_path_source(source_path: Path, dest: Path, *, overwrite: bool) -> Path:
    if dest.exists():
        if not overwrite:
            raise FileExistsError(dest)
        shutil.rmtree(dest)

    shutil.copytree(source_path, dest)
    return source_path


def _codec_sibling_suffix(codec: str) -> str:
    if is_htj2k_codec(codec):
        return "htj2k"
    return "jp2k"


def _sibling_image_key(key: str, codec: str, preset: str) -> str:
    """Return the sibling image key, e.g. ``morphology:jp2k_lossless``."""
    return f"{key}:{_codec_sibling_suffix(codec)}_{preset}"


def recompress_spatialdata(
    source: str | Path | Any,
    dest: str | Path,
    *,
    config: str | Path | dict[str, Any] | None = None,
    overwrite: bool = False,
    manifest: bool = True,
    image_key: str | None = None,
    codec: str | None = None,
    preset: ImagePreset | None = None,
    chunks: ChunkSpec | None = None,
    quality: float | None = None,
    reversible: bool | None = None,
    sibling: bool = False,
    workers: int | None = None,
) -> RecompressedSpatialData:
    """Preserve a SpatialData store and recompress configured rasters.

    When *sibling* is ``False`` (default) each configured image is rewritten
    in-place with the new codec.  When *sibling* is ``True`` the original
    image is kept and a new image group is added alongside it whose name is
    ``{original_key}:{codec}_{preset}`` (e.g. ``morphology_focus:jp2k_lossless``
    or ``morphology_focus:htj2k_balanced``). This lets the original remain
    available for tools that lack the target codec while the compressed version
    is used where it is supported.

    Path sources are copied before raster replacement, which keeps tables,
    shapes, points, and unconfigured rasters intact without loading the whole
    object.
    """

    import os

    worker_count = workers if workers is not None else (os.cpu_count() or 1)
    configure_encoder_pool(worker_count)

    dest_path = Path(dest)
    temp_dir: tempfile.TemporaryDirectory[str] | None = None
    try:
        if isinstance(source, str | Path):
            read_path = _prepare_path_source(Path(source), dest_path, overwrite=overwrite)
            source_label = str(source)
        else:
            if dest_path.exists():
                if not overwrite:
                    raise FileExistsError(dest_path)
                shutil.rmtree(dest_path)
            temp_dir = tempfile.TemporaryDirectory(prefix="spatialdata-codec-writer-")
            read_path = Path(temp_dir.name) / "source.zarr"
            source.write(str(read_path), overwrite=True)
            shutil.copytree(read_path, dest_path)
            source_label = None

        resolved_config = resolve_recompression_config(
            config,
            image_key=image_key,
            codec=codec,
            preset=preset,
            chunks=chunks,
            quality=quality,
            reversible=reversible,
        )

        image_keys = list(resolved_config.get("images") or {})
        if not image_keys:
            image_keys = _list_raster_keys(dest_path, "images")

        label_keys = list(resolved_config.get("labels") or {})
        if not label_keys and resolved_config.get("default_labels", {}).get("codec") == "blosc":
            label_keys = _list_raster_keys(dest_path, "labels")

        image_reports = []
        default_image = resolved_config.get("default_image", {})
        for key in image_keys:
            image_config = _deep_merge(default_image, resolved_config.get("images", {}).get(key, {}))
            resolved_codec = _resolve_image_codec(image_config, key)

            if sibling:
                dest_key = _sibling_image_key(
                    key,
                    resolved_codec,
                    _sibling_image_label(image_config),
                )
                sib_group_path = dest_path / "images" / dest_key
                if sib_group_path.exists():
                    shutil.rmtree(sib_group_path)
                sib_group_path.mkdir(parents=True)
                src_group_meta = read_path / "images" / key / "zarr.json"
                if src_group_meta.exists():
                    shutil.copy2(src_group_meta, sib_group_path / "zarr.json")
            else:
                dest_key = key

            for dataset in _datasets_from_raster_group(
                dest_path / "images" / key if not sibling else read_path / "images" / key
            ):
                source_raster = f"images/{key}/{dataset}"
                dest_raster = f"images/{dest_key}/{dataset}"
                image_reports.append(
                    _recompress_image_array(
                        source_array_path=read_path / source_raster,
                        dest_array_path=dest_path / dest_raster,
                        raster_path=dest_raster,
                        config=image_config,
                        workers=worker_count,
                    )
                )

        label_reports = []
        default_label = resolved_config.get("default_labels", {})
        if default_label.get("codec", "blosc") not in {"blosc", None}:
            raise ValueError(f"Unsupported label codec: {default_label.get('codec')!r}")
        for key in label_keys:
            label_config = _deep_merge(default_label, resolved_config.get("labels", {}).get(key, {}))
            if label_config.get("codec", "blosc") != "blosc":
                raise ValueError(
                    f"Labels only support Blosc compression in v1, got {label_config.get('codec')!r}"
                )
            for dataset in _datasets_from_raster_group(dest_path / "labels" / key):
                raster_path = f"labels/{key}/{dataset}"
                label_reports.append(
                    _recompress_label_array(
                        source_array_path=read_path / raster_path,
                        dest_array_path=dest_path / raster_path,
                        raster_path=raster_path,
                        config=label_config,
                    )
                )

        _refresh_consolidated_metadata(dest_path)

        manifest_data = {
            "format": "spatialdata-codec-recompression/v1",
            "source": source_label,
            "output": str(dest_path),
            "config": resolved_config,
            "images": image_reports,
            "labels": label_reports,
            "workers": worker_count,
            "packages": {
                "imagecodecs": package_version("imagecodecs"),
                "numpy": package_version("numpy"),
                "spatialdata": package_version("spatialdata"),
                "zarr": package_version("zarr"),
            },
        }
        manifest_path = dest_path.with_suffix(".manifest.json") if manifest else None
        if manifest_path is not None:
            write_json(manifest_path, manifest_data)
        return RecompressedSpatialData(dest_path, manifest_path, manifest_data)
    finally:
        if temp_dir is not None:
            temp_dir.cleanup()
