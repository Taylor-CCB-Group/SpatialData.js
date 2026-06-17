# spatialdata-codec-writer

Reference writer for small SpatialData/OME-Zarr image stores that use optional
image codecs such as JPEG 2000.

The package is structured as publishable Python code, but for now it lives in
this repository as the fixture generator and reference implementation for the
JavaScript `zarrextra`/Viv reader work.

## Install for local development

From the repository root:

```bash
uv run --directory python/spatialdata-codec-writer pytest
```

`uv run` resolves the pinned package dependencies from `pyproject.toml` and
`uv.lock`. The runtime dependencies include `spatialdata`, `zarr`,
`imagecodecs`, `ome-zarr`, `numpy`, `numcodecs`, and `dask`.

## Generate codec fixtures

Generate the JP2K fixture used by the JS integration tests:

```bash
uv run --directory python/spatialdata-codec-writer spatialdata-codec-writer generate-fixtures --output-dir ../../test-fixtures/codecs --overwrite
```

Inspect the generated manifest:

```bash
uv run --directory python/spatialdata-codec-writer spatialdata-codec-writer inspect ../../test-fixtures/codecs/jpeg2k.zarr
```

The manifest records the written image path, shape, dtype, chunk shape, codec
id, package versions, and representative chunk samples/checksums. The writer
decodes chunks after writing them so the JS tests can compare against Python's
reference output.

## Write a small image store

Use `write_codec_spatialdata` when you already have an image array or image-like
object and want a small SpatialData/OME-Zarr store:

```python
import numpy as np

from spatialdata_codec_writer import write_codec_spatialdata

image = np.arange(2 * 64 * 64, dtype=np.uint16).reshape(2, 64, 64)

written = write_codec_spatialdata(
    "example-jp2k.zarr",
    image=image,
    image_key="histology",
    codec="imagecodecs_jpeg2k",
    chunks=(1, 1, 1, 32, 32),
    overwrite=True,
)

print(written.manifest_path)
```

Images are normalized to `[t, c, z, y, x]`. If the object has named dimensions
such as an xarray `DataArray` or SpatialData image element, those names are
used. Without names, accepted shapes are `yx`, `cyx`, `czyx`, and `tczyx`.
For SpatialData multiscale image elements, the writer uses `scale0` as the
source image and can write a fresh multiscale output from it.

## Compress one image from an existing SpatialData object

Use `write_codec_spatialdata_image` to transcode one image from an existing
SpatialData object or SpatialData Zarr path:

```python
import spatialdata as sd

from spatialdata_codec_writer import write_codec_spatialdata_image

sdata = sd.read_zarr("input.sdata.zarr")

written = write_codec_spatialdata_image(
    "histology-jp2k.zarr",
    sdata,
    image_key="histology",
    codec="imagecodecs_jpeg2k",
    chunks=(1, 1, 1, 256, 256),
    overwrite=True,
)

print(written.manifest["image_path"])
```

The CLI has the same path-oriented workflow:

```bash
uv run --directory python/spatialdata-codec-writer spatialdata-codec-writer write-image input.sdata.zarr histology-jp2k.zarr --image-key histology --chunks 1 1 1 256 256 --overwrite
```

This is currently a focused image transcoder. It writes a new store containing
the selected image under `images/<image_key>` and does not yet preserve tables,
shapes, points, labels, or arbitrary source metadata from the input SpatialData
object. When using the CLI source-path form, the input must be readable by the
installed `spatialdata` Python package.

## Recompress an existing SpatialData store

Use `recompress_spatialdata` or the `recompress` CLI when you want to preserve a
whole SpatialData object and rewrite selected raster payloads. Path sources are
copied first, so tables, shapes, points, and unconfigured rasters are preserved
without loading the full object.

```bash
uv run --directory python/spatialdata-codec-writer spatialdata-codec-writer recompress input.sdata.zarr output-jp2k.zarr --image-key morphology_focus --preset balanced --chunks auto --overwrite
uv run --directory python/spatialdata-codec-writer spatialdata-codec-writer recompress input.sdata.zarr output-htj2k.zarr --image-key morphology_focus --codec experimental.openjph_htj2k --preset balanced --chunks auto --overwrite
```

For repeatable runs, prefer a JSON config file:

```json
{
  "default_image": { "codec": "imagecodecs_jpeg2k", "preset": "lossless", "chunks": "auto" },
  "images": {
    "morphology_focus": { "preset": "balanced" },
    "he_image": { "preset": "small" },
    "fast_preview": {
      "codec": "experimental.openjph_htj2k",
      "preset": "lossless",
      "chunks": "auto"
    }
  },
  "default_labels": { "codec": "blosc", "clevel": 5 }
}
```

```bash
uv run --directory python/spatialdata-codec-writer spatialdata-codec-writer recompress input.sdata.zarr output-jp2k.zarr --config recompress.json --overwrite
```

JP2K presets:

- `lossless`: writes reversible JP2K and validates decoded chunks exactly.
- `balanced`: writes near-lossless JP2K using `level=100`.
- `small`: writes more compact JP2K using `level=75`.

HTJ2K encode uses OpenJPH WASM only (`scripts/encode-htj2k-plane.mjs`) and labels
stores with `experimental.openjph_htj2k` (`encoder: openjph-wasm` in manifests).
Presets call `HTJ2KEncoder.setQuality(reversible, quality)` with float
quantization factors:

- `lossless`: `reversible=True` (exact round-trip).
- `balanced`: `reversible=False`, `quality=0.005`.
- `small`: `reversible=False`, `quality=0.01`.

Lower `quality` values preserve more detail and produce larger output. This is
not JP2K-style 0–100 rate control.

`generate-fixtures --experimental-htj2k` also emits
`htj2k-quality-sweep.manifest.json` (Mandelbrot plane, multiple qualities) and
`htj2k-encode-demo.manifest.json` (three 512×512 multiscale image layers in one
`htj2k-demo.zarr` store at lossless / balanced / small presets). The small
`htj2k.zarr` fixture remains for fast CI smoke tests.

Per-image config may also set `quality`, `reversible`, or `encode_options`.

Encode requires Node.js and `@cornerstonejs/codec-openjph` from this repository
(`pnpm install`). Native `imagecodecs` HTJ2K encode is not used; we may
re-evaluate it later. The frontend still decodes legacy
`experimental.imagecodecs_htj2k` stores. Sibling mode names HTJ2K outputs like
`morphology_focus:htj2k_balanced`.

Labels are not written with JP2K in v1. Label rasters are written with
Blosc/zstd level 5 by default so integer IDs remain lossless and browser-safe.

Browser-targeted JP2K output is limited to `uint8`, `int8`, `uint16`, and
`int16`. Wider integer, float, bool, and unknown dtypes are rejected for JP2K
with a clear error. Python `imagecodecs` may support some wider data, but the
current JavaScript OpenJPEG decoder path is not considered supported above
16-bit.

For a larger manual experiment:

```bash
uv run --directory python/spatialdata-codec-writer spatialdata-codec-writer recompress /Users/ptodd/data/spatialdata/sdata_inputs/xenium_rep1_io_spatialdata_0.7.1.zarr /private/tmp/xenium-rep1-morphology-focus-jp2k.zarr --image-key morphology_focus --preset balanced --chunks auto --overwrite
```

When viewing recompressed stores in a browser during iterative experiments,
serve them without HTTP caching or write each attempt to a fresh output path.
For example:

```bash
bunx http-server --cors -c-1 /private/tmp
```

This matters when using `--overwrite`: a browser can otherwise keep stale Zarr
metadata for up to the server cache lifetime and try to decode newly written
chunks with an old codec pipeline.

The recompressor writes a manifest beside the output with the expanded config,
per-raster shape/dtype/chunk metadata, encoded byte counts, package versions,
and representative decoded checksums.

## Experimental HTJ2K

JP2K uses the registered Zarr codec id `imagecodecs_jpeg2k`. HTJ2K encode uses
OpenJPH WASM and labels stores with `experimental.openjph_htj2k`
(`encoder: openjph-wasm`). The frontend also decodes legacy
`experimental.imagecodecs_htj2k` fixtures.

```bash
uv run --directory python/spatialdata-codec-writer spatialdata-codec-writer generate-fixtures --output-dir ../../test-fixtures/codecs --experimental-htj2k --overwrite
```

HTJ2K encoding requires Node.js and `@cornerstonejs/codec-openjph` from the
monorepo (`pnpm install`). If the encoder is unavailable, `generate-fixtures`
still writes `jpeg2k.zarr` and skips `htj2k.zarr` with a warning.

TypeScript callers can use `encodeHtj2kPlane()` / `createOpenJphEncoder()` from
`zarrextra` directly. See [htj2k-wasm-encode-design.md](docs/htj2k-wasm-encode-design.md).

Repository scripts may set `UV_CACHE_DIR=.tmp/uv-cache` to keep sandbox and CI
caches inside the working tree. That environment variable is not required for
normal local use.
