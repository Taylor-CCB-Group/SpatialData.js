# spatialdata-codec-writer

Publishable Python tool for recompressing SpatialData/OME-Zarr image stores with
optional browser-targeted codecs (JPEG 2000 and experimental HTJ2K, which is computationally cheaper).

This is a working prototype that may be used for experimenting with writing non-standard
stores that can as of this writing only be interpreted by the `spatialdata.js` runtime.
It is hoped that if found to be of benefit, these codecs can be adopted more broadly.
We may also review other options for comparison.

The package vendors OpenJPH WASM and runs it through a pool of persistent Node.js
encoder workers. **Runtime requirements:** Python 3.12+, Node.js on PATH, and
`imagecodecs` for JP2K encode/decode validation.

Codec test fixture generation lives in this repository under
`python/spatialdata-codec-writer/scripts/` (not exported from the installed wheel).

## Install

```bash
pip install spatialdata-codec-writer
```

For local development in this monorepo:

```bash
pnpm test:codec-writer
```

(`openjphjs.js` / `openjphjs.wasm` are gitignored; the script vendors them from
`@cornerstonejs/codec-openjph` before pytest.)

Before building or running HTJ2K tests manually:

```bash
node scripts/vendor-openjph-for-python.mjs
uv run --directory python/spatialdata-codec-writer pytest
```

## Recompress an existing SpatialData store

Use `recompress_spatialdata` or the `recompress` CLI when you want to preserve a
whole SpatialData object and rewrite selected raster payloads. Path sources are
copied first, so tables, shapes, points, root `spatialdata_attrs`, and
unconfigured rasters are preserved without loading the full object.

```bash
uv run --directory python/spatialdata-codec-writer spatialdata-codec-writer recompress input.sdata.zarr output-jp2k.zarr --image-key morphology_focus --preset balanced --chunks auto --overwrite
uv run --directory python/spatialdata-codec-writer spatialdata-codec-writer recompress input.sdata.zarr output-htj2k.zarr --image-key morphology_focus --codec experimental.openjph_htj2k --preset balanced --chunks auto --overwrite
```

To recompress **every** image with the same settings, omit `--image-key`; CLI flags update
`default_image` and apply to all image groups in the store:

```bash
uv run --directory python/spatialdata-codec-writer spatialdata-codec-writer recompress \
  input.sdata.zarr output-htj2k.zarr \
  --codec experimental.openjph_htj2k \
  --quality 0.0005 \
  --chunks auto \
  --sibling \
  --overwrite
```

With `--sibling`, each original image is kept and a compressed sibling is added alongside it
(e.g. `morphology_focus:htj2k_q0.0005`, `he_image:htj2k_q0.0005`).

Parallel encoding defaults to one worker per CPU (`--workers N` to override).

### Custom HTJ2K `quality` (instead of `--preset`)

Presets are shortcuts. For per-dataset tuning, pass an explicit OpenJPH quantization
factor. **Lower `quality` = higher fidelity and larger output** (not JP2K-style 0–100).

```bash
uv run --directory python/spatialdata-codec-writer spatialdata-codec-writer recompress \
  input.sdata.zarr output-htj2k.zarr \
  --image-key morphology_focus \
  --codec experimental.openjph_htj2k \
  --quality 0.001 \
  --chunks auto \
  --sibling \
  --overwrite
```

With `--sibling`, the new image is named from the quality, e.g.
`morphology_focus:htj2k_q0.001`.

Equivalent JSON config:

```json
{
  "images": {
    "morphology_focus": {
      "codec": "experimental.openjph_htj2k",
      "quality": 0.001,
      "chunks": "auto"
    }
  }
}
```

For repeatable runs with multiple images, prefer a JSON config file:

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

- `lossless`: reversible JP2K with exact round-trip validation.
- `balanced`: near-lossless JP2K (`level=100`).
- `small`: more compact JP2K (`level=75`).

HTJ2K encode uses vendored OpenJPH WASM (`experimental.openjph_htj2k`,
`encoder: openjph-wasm` in manifests). Presets call
`HTJ2KEncoder.setQuality(reversible, quality)`:

- `lossless`: `reversible=True`.
- `balanced`: `reversible=False`, `quality=0.0002`.
- `small`: `reversible=False`, `quality=0.001`.

See [`docs/htj2k-wasm-encode-design.md`](docs/htj2k-wasm-encode-design.md) for
calibration notes.

Labels are written with Blosc/zstd by default. Browser-targeted image codecs
support `uint8`, `int8`, `uint16`, and `int16` only.

The recompressor writes a sidecar manifest beside the output with the expanded
config, per-raster metadata, encoded byte counts, package versions, and
representative decoded checksums. Tool provenance lives in the manifest; source
store root `spatialdata_attrs` are preserved from the copy.

## Inspect manifests

```bash
uv run --directory python/spatialdata-codec-writer spatialdata-codec-writer inspect output-jp2k.manifest.json
```

## Generate codec fixtures (monorepo dev only)

Fixture generation is **not** part of the published CLI. From the repository root:

```bash
pnpm test:fixtures:generate:codecs
```

Or directly:

```bash
node scripts/vendor-openjph-for-python.mjs
uv run --directory python/spatialdata-codec-writer python scripts/generate_codec_fixtures.py --output-dir ../../test-fixtures/codecs --experimental-htj2k --overwrite
```

Dev fixtures stamp root metadata with `experimental_codec_writer` (not a fake
`spatialdata` library version) to signal they are codec test artifacts. See
`docs/docs/vis/codec-fixtures.mdx` for browser demo instructions and a note on
provenance standardization.

### Manual multi-dimensional volumes

Default generated fixtures use shape `[1, 1, 1, H, W]`. For ad-hoc synthetic stores, use
`write-synthetic`:

```bash
# From the monorepo root (pnpm forwards extra args after --)
pnpm write-synthetic -- ~/data/spatialdata/sdata_inputs/mandelbulb.zarr \
  --pattern mandelbulb --size 1024 --z 128 --t 1 --c 1 \
  --image-key mandelbulb --chunk-spatial 256 --overwrite

# Or directly via uv
node scripts/vendor-openjph-for-python.mjs
uv run --directory python/spatialdata-codec-writer spatialdata-codec-writer-write-synthetic \
  ~/path/out.zarr --pattern indexed --size 64 --t 2 --z 3 --codec imagecodecs_jpeg2k
```

Patterns: `mandelbulb` (default), `indexed`, `mandelbrot` (single 2D plane), `fractal`
(legacy fixture shape). HTJ2K is the default codec; use `--preset balanced` or
`--quality 0.001` for lossy output.

Richer, biologically motivated or compression-aware synthesis is planned
possibly as future JS-side tooling rather than growing this Python module further.

## Python API

```python
from spatialdata_codec_writer import recompress_spatialdata

result = recompress_spatialdata(
    "input.sdata.zarr",
    "output-jp2k.zarr",
    image_key="morphology_focus",
    preset="balanced",
    chunks="auto",
    overwrite=True,
    workers=4,
)
print(result.manifest_path)
```

TypeScript callers can use `encodeHtj2kPlane()` from `zarrextra` directly.
See [htj2k-wasm-encode-design.md](docs/htj2k-wasm-encode-design.md).
