from __future__ import annotations

import json
import shutil
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Literal

import imagecodecs
import numpy as np
import zarr
from zarr.codecs import BloscCodec, BloscShuffle

from .writer import CODEC_JPEG2K, _package_version, _sha256, _write_json

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


def resolve_recompression_config(
    config: str | Path | dict[str, Any] | None = None,
    *,
    image_key: str | None = None,
    preset: ImagePreset | None = None,
    chunks: ChunkSpec | None = None,
) -> dict[str, Any]:
    """Return normalized recompression config after CLI shortcut expansion."""

    resolved = _deep_merge(_default_config(), _load_config(config))
    if image_key is not None:
        image_cfg = dict(resolved.get("images", {}).get(image_key, {}))
        if preset is not None:
            image_cfg["preset"] = preset
        if chunks is not None:
            image_cfg["chunks"] = chunks
        resolved.setdefault("images", {})[image_key] = image_cfg
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


def _validate_jp2k_dtype(dtype: np.dtype, raster_path: str) -> None:
    if dtype not in SUPPORTED_BROWSER_JP2K_DTYPES:
        supported = ", ".join(
            str(dtype) for dtype in sorted(SUPPORTED_BROWSER_JP2K_DTYPES, key=str)
        )
        raise TypeError(
            f"JP2K browser fixtures support only <=16-bit integer dtypes ({supported}); "
            f"{raster_path} has dtype {dtype}. Use Blosc for labels or skip this raster."
        )


def _validate_jp2k_chunks(chunks: tuple[int, ...], raster_path: str) -> None:
    if len(chunks) < 2:
        raise ValueError(f"{raster_path} must be at least 2D")
    non_spatial = chunks[:-2]
    if any(chunk != 1 for chunk in non_spatial):
        raise ValueError(
            f"{raster_path} JP2K chunks must have singleton non-spatial axes; got {chunks}."
        )


def _chunk_grid(shape: tuple[int, ...], chunks: tuple[int, ...]) -> list[tuple[int, ...]]:
    ranges = [range((size + chunk - 1) // chunk) for size, chunk in zip(shape, chunks)]
    out: list[tuple[int, ...]] = [()]
    for values in ranges:
        out = [(*prefix, value) for prefix in out for value in values]
    return out


def _chunk_slices(
    shape: tuple[int, ...], chunks: tuple[int, ...], coords: tuple[int, ...]
) -> tuple[slice, ...]:
    slices = []
    for coord, chunk, size in zip(coords, chunks, shape):
        start = coord * chunk
        slices.append(slice(start, min(start + chunk, size)))
    return tuple(slices)


def _pad_chunk(chunk: np.ndarray, chunks: tuple[int, ...]) -> np.ndarray:
    if chunk.shape == chunks:
        return chunk
    padded = np.zeros(chunks, dtype=chunk.dtype)
    padded[tuple(slice(0, size) for size in chunk.shape)] = chunk
    return padded


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


def _preset_encode_options(config: dict[str, Any]) -> dict[str, Any]:
    preset = config.get("preset", "lossless")
    if preset not in JP2K_PRESETS:
        raise ValueError(f"Unknown JP2K preset {preset!r}; expected one of {sorted(JP2K_PRESETS)}")
    options = dict(JP2K_PRESETS[preset])
    options.update(config.get("encode_options", {}))
    for key in ("level", "reversible", "codecformat", "numthreads"):
        if key in config:
            options[key] = config[key]
    return options


def _encode_jp2k_plane(plane: np.ndarray, encode_options: dict[str, Any]) -> bytes:
    return imagecodecs.jpeg2k_encode(np.asarray(plane), **encode_options)


def _sample_values(plane: np.ndarray) -> list[int | float]:
    values = [
        plane[0, 0],
        plane[0, min(1, plane.shape[1] - 1)],
        plane[min(1, plane.shape[0] - 1), 0],
    ]
    return [value.item() if hasattr(value, "item") else value for value in values]


def _recompress_image_array(
    *,
    source_array_path: Path,
    dest_array_path: Path,
    raster_path: str,
    config: dict[str, Any],
) -> dict[str, Any]:
    source_meta = _read_json(source_array_path / "zarr.json")
    source_array = zarr.open(str(source_array_path), mode="r")
    shape = tuple(int(value) for value in source_array.shape)
    dtype = np.dtype(source_array.dtype)
    _validate_jp2k_dtype(dtype, raster_path)

    chunks = _normalize_chunks(config.get("chunks", "auto"), shape, image=True)
    _validate_jp2k_chunks(chunks, raster_path)
    encode_options = _preset_encode_options(config)
    is_lossless = bool(encode_options.get("reversible", False))

    if dest_array_path.exists():
        shutil.rmtree(dest_array_path)
    (dest_array_path / "c").mkdir(parents=True)
    _write_json(
        dest_array_path / "zarr.json",
        _array_metadata_from_source(
            source_meta,
            chunks=chunks,
            codecs=[{"name": CODEC_JPEG2K, "configuration": {}}],
        ),
    )

    chunks_checked: list[dict[str, Any]] = []
    encoded_bytes = 0
    chunk_count = 0
    for coords in _chunk_grid(shape, chunks):
        selection = _chunk_slices(shape, chunks, coords)
        chunk = _pad_chunk(np.asarray(source_array[selection]), chunks)
        plane = chunk.reshape(chunk.shape[-2], chunk.shape[-1])
        encoded = _encode_jp2k_plane(plane, encode_options)
        encoded_bytes += len(encoded)
        chunk_count += 1

        chunk_rel = Path("c").joinpath(*(str(coord) for coord in coords))
        chunk_path = dest_array_path / chunk_rel
        chunk_path.parent.mkdir(parents=True, exist_ok=True)
        chunk_path.write_bytes(encoded)

        if len(chunks_checked) < 4:
            decoded = imagecodecs.jpeg2k_decode(encoded)
            decoded_plane = decoded.reshape(plane.shape)
            if is_lossless and not np.array_equal(decoded_plane, plane):
                raise RuntimeError(
                    f"Lossless JP2K self-validation failed for {raster_path} chunk {coords}"
                )
            chunks_checked.append(
                {
                    "coords": list(coords),
                    "encoded_sha256": _sha256(encoded),
                    "decoded_sha256": _sha256(decoded_plane.tobytes()),
                    "source_sha256": _sha256(plane.tobytes()),
                    "samples": _sample_values(decoded_plane),
                }
            )

    return {
        "path": raster_path,
        "codec": CODEC_JPEG2K,
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
    source_array = zarr.open(str(source_array_path), mode="r")
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
    for coords in _chunk_grid(shape, chunks):
        selection = _chunk_slices(shape, chunks, coords)
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
    _write_json(root_path, root_meta)


def _prepare_path_source(source_path: Path, dest: Path, *, overwrite: bool) -> Path:
    if dest.exists():
        if not overwrite:
            raise FileExistsError(dest)
        shutil.rmtree(dest)

    shutil.copytree(source_path, dest)
    return source_path


def _sibling_image_key(key: str, preset: str) -> str:
    """Return the sibling image key for an image, e.g. ``morphology:jp2k_lossless``."""
    return f"{key}:jp2k_{preset}"


def recompress_spatialdata(
    source: str | Path | Any,
    dest: str | Path,
    *,
    config: str | Path | dict[str, Any] | None = None,
    overwrite: bool = False,
    manifest: bool = True,
    image_key: str | None = None,
    preset: ImagePreset | None = None,
    chunks: ChunkSpec | None = None,
    sibling: bool = False,
) -> RecompressedSpatialData:
    """Preserve a SpatialData store and recompress configured rasters.

    When *sibling* is ``False`` (default) each configured image is rewritten
    in-place with the new codec.  When *sibling* is ``True`` the original
    image is kept and a new image group is added alongside it whose name is
    ``{original_key}:jp2k_{preset}`` (e.g. ``morphology_focus:jp2k_lossless``).
    This lets the original remain available for tools that lack the JP2K codec
    while the compressed version is used where it is supported.

    Path sources are copied before raster replacement, which keeps tables,
    shapes, points, and unconfigured rasters intact without loading the whole
    object.
    """

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
            preset=preset,
            chunks=chunks,
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
            if image_config.get("codec", CODEC_JPEG2K) != CODEC_JPEG2K:
                raise ValueError(f"Unsupported image codec for {key!r}: {image_config.get('codec')!r}")

            if sibling:
                dest_key = _sibling_image_key(key, image_config.get("preset", "lossless"))
                # Copy the source group metadata (zarr.json + multiscales attrs) into the sibling key.
                sib_group_path = dest_path / "images" / dest_key
                if sib_group_path.exists():
                    shutil.rmtree(sib_group_path)
                sib_group_path.mkdir(parents=True)
                src_group_meta = read_path / "images" / key / "zarr.json"
                if src_group_meta.exists():
                    shutil.copy2(src_group_meta, sib_group_path / "zarr.json")
            else:
                dest_key = key

            for dataset in _datasets_from_raster_group(dest_path / "images" / key if not sibling else read_path / "images" / key):
                source_raster = f"images/{key}/{dataset}"
                dest_raster = f"images/{dest_key}/{dataset}"
                image_reports.append(
                    _recompress_image_array(
                        source_array_path=read_path / source_raster,
                        dest_array_path=dest_path / dest_raster,
                        raster_path=dest_raster,
                        config=image_config,
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
            "packages": {
                "imagecodecs": _package_version("imagecodecs"),
                "numpy": _package_version("numpy"),
                "spatialdata": _package_version("spatialdata"),
                "zarr": _package_version("zarr"),
            },
        }
        manifest_path = dest_path.with_suffix(".manifest.json") if manifest else None
        if manifest_path is not None:
            _write_json(manifest_path, manifest_data)
        return RecompressedSpatialData(dest_path, manifest_path, manifest_data)
    finally:
        if temp_dir is not None:
            temp_dir.cleanup()
