from __future__ import annotations

import json
import shutil
import tempfile
import warnings
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
    HTJ2K_QUALITY_FLOOR_LSB,
    SUPPORTED_IMAGE_CODECS,
    chunk_grid,
    chunk_slices,
    decode_image_plane,
    dtype_quantum,
    encode_image_plane,
    is_htj2k_codec,
    pad_chunk,
)
from .codecs.backends import (
    BACKEND_OPENJPH_WASM,
    backend_report,
    htj2k_available,
    resolve_backend,
)
from .codecs.htj2k_wasm import configure_encoder_pool
from .provenance import package_version, sha256
from .pyramids import DEFAULT_MIN_SIZE as DEFAULT_PYRAMID_MIN_SIZE
from .store import read_json, refresh_consolidated_metadata, write_json

ImagePreset = Literal["lossless", "balanced", "small"]
ChunkSpec = Literal["auto"] | tuple[int, ...] | list[int]

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

# Lossy HTJ2K presets are a multiple of the input's LSB, not an absolute step.
# OpenJPH's `quality` is normalised to the dtype's full range, so size and error
# both track the step measured in LSB — the same multiple costs the same on uint8
# and uint16. Below ~1 LSB (`HTJ2K_QUALITY_FLOOR_LSB`) the irreversible path is
# strictly dominated: it returns a bit-identical image for more bytes than
# reversible. See docs/htj2k-wasm-encode-design.md for the measurements.
HTJ2K_PRESETS: dict[ImagePreset, dict[str, Any]] = {
    "lossless": {"reversible": True},
    # Mean error ~0.6 LSB, p99 2 LSB.
    "balanced": {"reversible": False, "quality_lsb": 2.0},
    # Mean error ~1.6 LSB, p99 5 LSB.
    "small": {"reversible": False, "quality_lsb": 5.0},
}


def htj2k_preset_quality(preset: ImagePreset, dtype: np.dtype) -> float | None:
    """Resolve an HTJ2K preset to a quantization step, or ``None`` if reversible."""
    quality_lsb = HTJ2K_PRESETS[preset].get("quality_lsb")
    if quality_lsb is None:
        return None
    return float(quality_lsb) * dtype_quantum(dtype)


@dataclass(frozen=True)
class RecompressedSpatialData:
    store_path: Path
    manifest_path: Path | None
    manifest: dict[str, Any]


def _load_config(config: str | Path | dict[str, Any] | None) -> dict[str, Any]:
    if config is None:
        return {}
    if isinstance(config, dict):
        return json.loads(json.dumps(config))
    return read_json(Path(config))


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
    return read_json(meta_path).get("attributes", {})


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
            meta = read_json(child / "zarr.json")
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
    if codec == CODEC_HTJ2K_OPENJPH and not htj2k_available():
        raise RuntimeError(
            f"HTJ2K recompression requested for {raster_key!r}, but no HTJ2K backend is "
            "available. Install `imagecodecs` with HTJ2K support, or put Node.js on PATH "
            "to use the vendored openjph-wasm backend."
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


def _preset_encode_options(
    config: dict[str, Any], *, codec: str, dtype: np.dtype | None = None
) -> dict[str, Any]:
    """Resolve config plus preset into concrete encode options.

    HTJ2K presets are bit-depth relative, so *dtype* is required to resolve one;
    it also lets an explicit ``quality`` be checked against the input's LSB.
    """
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

    # An explicit `quality` overrides the preset, including its LSB multiple.
    preset_quality_lsb = options.pop("quality_lsb", None)
    if preset_quality_lsb is not None and options.get("quality") is None:
        if dtype is None:
            described = f"{preset!r} preset" if preset is not None else "quality_lsb setting"
            raise ValueError(
                f"Resolving the HTJ2K {described} needs the input dtype: the "
                "quantization step is relative to the input's bit depth."
            )
        options["quality"] = float(preset_quality_lsb) * dtype_quantum(dtype)

    if options.get("quality") is not None and not explicit_lossless:
        options["reversible"] = False
        _warn_if_quality_below_input_resolution(options["quality"], dtype)

    return options


def _warn_if_quality_below_input_resolution(quality: float, dtype: np.dtype | None) -> None:
    """Warn when a step is finer than one input LSB, which encodes larger than
    lossless for a bit-identical image. Only an explicit ``quality`` can ask for
    this; presets stay above the floor."""
    # Nothing to compare against for a dtype with no LSB (see `dtype_quantum`);
    # an explicit step stays legal there, so this stays silent rather than raising.
    if dtype is None or dtype.kind not in ("i", "u"):
        return
    floor = HTJ2K_QUALITY_FLOOR_LSB * dtype_quantum(dtype)
    if quality >= floor:
        return
    warnings.warn(
        f"HTJ2K quality={quality:g} is finer than one {dtype} LSB ({dtype_quantum(dtype):g}); "
        f"the irreversible transform will return a bit-identical image while encoding "
        f"LARGER than lossless. Use quality>={floor:g} for a genuinely smaller file, "
        f"or reversible=True (preset 'lossless') for the smallest exact one.",
        UserWarning,
        stacklevel=3,
    )


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


def _chunk_plane(
    source_array: Any, shape: tuple[int, ...], chunks: tuple[int, ...], coords: tuple[int, ...]
) -> np.ndarray:
    selection = chunk_slices(shape, chunks, coords)
    chunk = pad_chunk(np.asarray(source_array[selection]), chunks)
    return chunk.reshape(chunk.shape[-2], chunk.shape[-1])


def _write_encoded_chunk(
    dest_array_path: Path, coords: tuple[int, ...], encoded: bytes | bytearray
) -> None:
    chunk_rel = Path("c").joinpath(*(str(coord) for coord in coords))
    chunk_path = dest_array_path / chunk_rel
    chunk_path.parent.mkdir(parents=True, exist_ok=True)
    chunk_path.write_bytes(encoded)


def _maybe_record_chunk_check(
    *,
    chunks_checked: list[dict[str, Any]],
    coords: tuple[int, ...],
    encoded: bytes | bytearray,
    plane: np.ndarray,
    codec: str,
    raster_path: str,
    is_lossless: bool,
) -> None:
    if len(chunks_checked) >= 4:
        return
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


def _recompress_image_array(
    *,
    source_array_path: Path,
    dest_array_path: Path,
    raster_path: str,
    config: dict[str, Any],
    workers: int,
) -> dict[str, Any]:
    source_meta = read_json(source_array_path / "zarr.json")
    source_array = zarr.open_array(str(source_array_path), mode="r")
    shape = tuple(int(value) for value in source_array.shape)
    dtype = np.dtype(source_array.dtype)
    codec = _resolve_image_codec(config, raster_path)
    _validate_browser_image_codec_dtype(dtype, raster_path)

    chunks = _normalize_chunks(config.get("chunks", "auto"), shape, image=True)
    _validate_browser_image_codec_chunks(chunks, raster_path)
    encode_options = _preset_encode_options(config, codec=codec, dtype=dtype)
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

    chunk_coords_list = list(chunk_grid(shape, chunks))
    chunks_checked: list[dict[str, Any]] = []
    encoded_bytes = 0
    chunk_count = 0

    if workers <= 1 or len(chunk_coords_list) <= 1:
        for coords in chunk_coords_list:
            plane = _chunk_plane(source_array, shape, chunks, coords)
            encoded = _encode_chunk_task(plane, codec, encode_options)
            encoded_bytes += len(encoded)
            chunk_count += 1
            _write_encoded_chunk(dest_array_path, coords, encoded)
            _maybe_record_chunk_check(
                chunks_checked=chunks_checked,
                coords=coords,
                encoded=encoded,
                plane=plane,
                codec=codec,
                raster_path=raster_path,
                is_lossless=is_lossless,
            )
    else:
        with ThreadPoolExecutor(max_workers=workers) as executor:
            future_to_job = {
                executor.submit(_encode_chunk_task, plane, codec, encode_options): (coords, plane)
                for coords in chunk_coords_list
                for plane in [_chunk_plane(source_array, shape, chunks, coords)]
            }
            for future in as_completed(future_to_job):
                coords, plane = future_to_job[future]
                encoded = future.result()
                encoded_bytes += len(encoded)
                chunk_count += 1
                _write_encoded_chunk(dest_array_path, coords, encoded)
                _maybe_record_chunk_check(
                    chunks_checked=chunks_checked,
                    coords=coords,
                    encoded=encoded,
                    plane=plane,
                    codec=codec,
                    raster_path=raster_path,
                    is_lossless=is_lossless,
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
        backend = resolve_backend()
        report["encoder"] = HTJ2K_ENCODER
        report["encoder_backend"] = backend.name if backend else None
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
    source_meta = read_json(source_array_path / "zarr.json")
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

    meta = read_json(dest_array_path / "zarr.json")
    return {
        "path": raster_path,
        "codec": "blosc",
        "shape": list(shape),
        "dtype": str(dtype),
        "chunks": list(chunks),
        "chunk_count": chunk_count,
        "codecs": meta.get("codecs", []),
    }


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


def _stage_pyramids(
    *,
    read_path: Path,
    staging_path: Path,
    image_keys: list[str],
    levels: int | Literal["auto"],
    downscale: int,
    min_size: int,
    force: bool,
) -> tuple[list[dict[str, Any]], dict[str, Path]]:
    """Build pyramids for *image_keys* into a staging store.

    Returns the per-raster reports and, for each key that was actually rebuilt,
    the root to read its levels from.
    """
    import spatialdata as sd

    from .pyramids import build_pyramids_into

    shutil.copytree(read_path, staging_path)
    reports = build_pyramids_into(
        source_sdata=sd.read_zarr(read_path),
        dest_sdata=sd.read_zarr(staging_path),
        keys=image_keys,
        collection="images",
        levels=levels,
        downscale=downscale,
        min_size=min_size,
        force=force,
    )
    roots = {
        report["path"].split("/", 1)[1]: staging_path
        for report in reports
        if report.get("action") == "rebuilt"
    }
    return reports, roots


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
    pyramid: bool = False,
    pyramid_levels: int | Literal["auto"] = "auto",
    pyramid_downscale: int = 2,
    pyramid_min_size: int = DEFAULT_PYRAMID_MIN_SIZE,
    pyramid_force: bool = False,
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

    With *pyramid*, any configured image that has only one resolution level is
    given a multiscale pyramid before it is recompressed, so single-resolution
    acquisition output becomes browser-ready in one pass. Images that already
    have a pyramid are left alone unless *pyramid_force* is set. See
    `spatialdata_js_util.pyramids` for how levels are chosen.
    """

    import os

    worker_count = workers if workers is not None else (os.cpu_count() or 1)
    # Only the WASM backend has a worker pool to size; `imagecodecs` releases the
    # GIL in its own encoder, so the ThreadPoolExecutor below is enough.
    selected = resolve_backend()
    if selected is not None and selected.name == BACKEND_OPENJPH_WASM:
        configure_encoder_pool(worker_count)

    dest_path = Path(dest)
    temp_dir: tempfile.TemporaryDirectory[str] | None = None
    pyramid_dir: tempfile.TemporaryDirectory[str] | None = None
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

        # Pyramids are staged in their own store rather than written straight into
        # dest: the recompressor deletes a destination array before streaming the
        # source into it, so reading the new levels from dest would pull the rug
        # out from under itself.
        pyramid_reports: list[dict[str, Any]] = []
        pyramid_roots: dict[str, Path] = {}
        if pyramid:
            pyramid_dir = tempfile.TemporaryDirectory(prefix="spatialdata-js-util-pyramid-")
            pyramid_reports, pyramid_roots = _stage_pyramids(
                read_path=read_path,
                staging_path=Path(pyramid_dir.name) / "pyramid.zarr",
                image_keys=image_keys,
                levels=pyramid_levels,
                downscale=pyramid_downscale,
                min_size=pyramid_min_size,
                force=pyramid_force,
            )

        image_reports = []
        default_image = resolved_config.get("default_image", {})
        for key in image_keys:
            image_config = _deep_merge(default_image, resolved_config.get("images", {}).get(key, {}))
            resolved_codec = _resolve_image_codec(image_config, key)
            # Rebuilt images are read from staging; everything else from the source.
            raster_root = pyramid_roots.get(key, read_path)

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
                src_group_meta = raster_root / "images" / key / "zarr.json"
                if src_group_meta.exists():
                    shutil.copy2(src_group_meta, sib_group_path / "zarr.json")
            else:
                dest_key = key
                if key in pyramid_roots:
                    # Replace the copied single-level group wholesale so the store
                    # declares the new levels and keeps no stale ones.
                    dest_group = dest_path / "images" / dest_key
                    if dest_group.exists():
                        shutil.rmtree(dest_group)
                    dest_group.mkdir(parents=True)
                    shutil.copy2(
                        raster_root / "images" / key / "zarr.json", dest_group / "zarr.json"
                    )

            group_for_datasets = (
                raster_root / "images" / key
                if sibling or key in pyramid_roots
                else dest_path / "images" / key
            )
            for dataset in _datasets_from_raster_group(group_for_datasets):
                source_raster = f"images/{key}/{dataset}"
                dest_raster = f"images/{dest_key}/{dataset}"
                image_reports.append(
                    _recompress_image_array(
                        source_array_path=raster_root / source_raster,
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

        refresh_consolidated_metadata(dest_path)

        manifest_data = {
            "format": "spatialdata-codec-recompression/v1",
            "source": source_label,
            "output": str(dest_path),
            "config": resolved_config,
            "images": image_reports,
            "labels": label_reports,
            "workers": worker_count,
            "pyramids": pyramid_reports,
            "htj2k": backend_report(),
            "packages": {
                "imagecodecs": package_version("imagecodecs"),
                "numpy": package_version("numpy"),
                "spatialdata": package_version("spatialdata"),
                "spatialdata-js-util": package_version("spatialdata-js-util"),
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
        if pyramid_dir is not None:
            pyramid_dir.cleanup()
