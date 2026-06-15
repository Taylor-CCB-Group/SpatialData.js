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
```

For repeatable runs, prefer a JSON config file:

```json
{
  "default_image": { "codec": "imagecodecs_jpeg2k", "preset": "lossless", "chunks": "auto" },
  "images": {
    "morphology_focus": { "preset": "balanced" },
    "he_image": { "preset": "small" }
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

Per-image config may also pass advanced `imagecodecs.jpeg2k_encode` options via
`encode_options`, or by setting supported top-level options such as `level`,
`reversible`, `codecformat`, and `numthreads`.

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

JP2K uses the registered Zarr codec id `imagecodecs_jpeg2k`. HTJ2K support is
behind the explicitly non-standard id `experimental.imagecodecs_htj2k` and is
intended for experiments only until there is community/registry alignment.

```bash
uv run --directory python/spatialdata-codec-writer spatialdata-codec-writer generate-fixtures --experimental-htj2k
```

Repository scripts may set `UV_CACHE_DIR=.tmp/uv-cache` to keep sandbox and CI
caches inside the working tree. That environment variable is not required for
normal local use.
