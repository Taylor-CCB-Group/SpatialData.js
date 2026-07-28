# spatialdata-js-util

Python utilities for producing — and reading back — SpatialData stores tuned for
incremental reading in the browser by
[SpatialData.js](https://github.com/Taylor-CCB-Group/SpatialData.js).

Three optimizations, all aimed at making a viewport cost a few small ranged reads
instead of a whole-element download:

| Area | What it does | Why |
|------|--------------|-----|
| **images** | Recompress rasters as JPEG 2000 or HTJ2K, and add [multiscale pyramids](#multiscale-pyramids) where they are missing | Tiles decode in the browser; HTJ2K is markedly cheaper to decode than JPEG 2000. Without a pyramid, a zoomed-out view still costs full-resolution chunks |
| **points** | Morton-sort Points Parquet with sentinel bbox rows and controlled row groups | A viewport maps to a few Parquet row-group reads |
| **tables** | Convert `X`/layers from CSR to CSC | Reading one gene becomes one contiguous range read, not a scan of every row |

Installing the package also **registers the image codecs with zarr**, so stores
written here open in ordinary `spatialdata.read_zarr` — see
[Reading stores back in Python](#reading-stores-back-in-python).

Every command is available three ways: an [interactive TUI](#interactive-tui)
(start here), the `spatialdata-js-util` CLI, and the [Python API](#python-api).

> **Status: experimental.** The HTJ2K codec identifier is not a standard
> OME-Zarr codec. Stores using it are readable by the `SpatialData.js` runtime
> and by Python with this package installed. It is published in the hope that,
> if useful, the approach can be adopted more broadly.

## Install

```bash
pip install spatialdata-js-util
```

That base install is enough to **read** stores. To **write** them, add the
`write` extra, which pulls in `spatialdata`, `anndata`, `dask` and `scipy`:

```bash
pip install 'spatialdata-js-util[write]'
```

Requires Python 3.12+ and `spatialdata >= 0.8.0`.

## Interactive TUI

If you would rather not memorise flags, everything below is also available as a
terminal UI. It is the easiest way to get started.

```bash
pip install 'spatialdata-js-util[tui]'
spatialdata-js-util tui

# Or pre-fill the store path so you skip the first prompt
spatialdata-js-util tui ~/data/xenium.zarr
```

Pick a command from the home menu and the UI walks you through it:

```
IMAGES   Recompress rasters (JPEG 2000 / HTJ2K)
POINTS   List Points elements in a Zarr store
POINTS   Morton-sort Points from Zarr
POINTS   Morton-sort CSV/Parquet file
POINTS   Write multiscale Points Parquet
POINTS   Write index permutations derivative store
TABLES   List table elements in a Zarr store
TABLES   Convert table matrices to CSC
CODECS   Show HTJ2K backend availability
```

The flow is the same for every command: **guided form → confirm → run → report.**

- **Forms** are pre-filled with sensible defaults, and with the store path you
  already used this session. `Enter` advances between fields and submits on the
  last one; `Escape` goes back; `q` quits.
- **Anything that overwrites asks first.** Rewriting `points/<key>/points.parquet`
  in place, converting tables in place, or replacing an existing output store all
  stop on a confirmation screen naming the exact path before touching anything.
- **Runs stream their JSON output** to a log pane, so a long recompression shows
  progress rather than appearing to hang.
- The recompress form carries the [pyramid](#multiscale-pyramids) controls, so
  single-resolution input can be made browser-ready without leaving the UI.
- **Writes are verified afterwards** and the report screen shows a pass/fail
  table. For Morton writes that means:

  | Check | Meaning |
  |-------|---------|
  | `column_present` | `morton_code_2d` column exists |
  | `sentinel_prefix` | First 2–4 rows have `morton_code_2d == 0` |
  | `sentinel_bbox` | Sentinel rows encode the full dataset x/y bounds |
  | `morton_monotonic` | Morton codes non-decreasing after sentinels |
  | `row_group_sentinels` | Row group 0 contains only sentinel rows |
  | `no_uint_intermediates` | No persisted `*_uint` staging columns |

  Multiscale and index-permutation runs show schema/manifest checks instead.

`CODECS → Show HTJ2K backend availability` is a good first stop: it tells you
which codec backend your environment resolved to, and whether it passed the
multi-component probe described [below](#htj2k-backends-and-why-there-is-a-probe).

### Reading stores back in Python

```python
import spatialdata as sd

sdata = sd.read_zarr("store-htj2k.zarr")   # HTJ2K/JP2K images decode transparently
```

No import of this package and no `register_codecs()` call is needed — the codecs
are advertised through `zarr.codecs` entry points, so zarr finds them as soon as
the distribution is installed. (`spatialdata_js_util.codecs.register_codecs()`
exists only for running from a source tree with no installed metadata.)

### HTJ2K backends, and why there is a probe

HTJ2K encode/decode can go through either of two OpenJPH builds:

- **`imagecodecs`** — native OpenJPH, pure `pip install`, no Node.js. Preferred.
- **`openjph-wasm`** — the vendored WASM the JS reader uses, driven by Node.js
  worker processes. Requires `node` on `PATH`.

A WASM build previously used in this project silently decoded *every* component
of a multi-component codestream as component 0 — losing volumetric planes with
no error (see [`docs/multi-component-codec-findings.md`](docs/multi-component-codec-findings.md)).
Because that failure is silent, a backend is not trusted on the strength of its
library name. `imagecodecs` is admitted only if it decodes a committed
multi-component codestream — produced by the WASM encoder — to exactly the
expected samples. Any mismatch, and it is rejected in favour of the WASM path.

Check what your environment resolved to:

```bash
spatialdata-js-util codecs info
```

Pin a backend explicitly with `SPATIALDATA_JS_UTIL_HTJ2K_BACKEND=imagecodecs`
or `=openjph-wasm` (the probe still gates `imagecodecs`).

## Images

Recompress a store, preserving everything that is not an image. Path sources are
copied first, so tables, shapes, points and unconfigured rasters survive without
the whole object being loaded.

```bash
spatialdata-js-util images recompress input.zarr output-htj2k.zarr \
  --codec experimental.openjph_htj2k --preset balanced --chunks auto --overwrite
```

With `--sibling`, each original image is kept and a compressed copy added
alongside it (`morphology_focus:htj2k_balanced`), so tools without the codec keep
working.

### Presets and `--quality`

`--quality` is the OpenJPH quantization step: **lower means higher fidelity and a
larger codestream** — not a JPEG-style 0–100 scale.

| Preset | JPEG 2000 | HTJ2K |
|--------|-----------|-------|
| `lossless` | reversible, round-trip verified | `reversible=True` |
| `balanced` | `level=100` | `quality=0.0002` |
| `small` | `level=75` | `quality=0.001` |

```bash
spatialdata-js-util images recompress input.zarr out.zarr \
  --codec experimental.openjph_htj2k --quality 0.0005 --sibling --overwrite
```

### Multiscale pyramids

Acquisition output is often written at a single resolution. A browser then has no
choice but to fetch full-resolution chunks however far out the user is zoomed —
which defeats the image codecs rather than complementing them. `--pyramid` gives
any single-level image a pyramid before recompressing it, so one command turns
single-resolution input into a browser-ready store:

```bash
spatialdata-js-util images recompress input.zarr output.zarr \
  --codec experimental.openjph_htj2k --preset balanced --pyramid --overwrite
```

To add pyramids without touching codecs:

```bash
spatialdata-js-util images add-pyramid input.zarr output.zarr --overwrite
```

By default levels are chosen automatically: keep halving until the largest
spatial axis is `--pyramid-min-size` (1024) or smaller, so the coarsest level is
roughly one chunk. Override with `--pyramid-levels N` (a *total* count including
full resolution) and `--pyramid-downscale K`.

Images that already have more than one level are **skipped**, and the manifest
says so; `--pyramid-force` rebuilds them anyway. Pass `--labels` to
`add-pyramid` to include label elements — they are downsampled by the label
model, so ids are never averaged into values that identify no object.

Full resolution is copied through unchanged; only the added levels are new.
Levels are generated through SpatialData's own parsers, which get the per-level
scale *and* half-pixel translation right — hand-written `multiscales` metadata
tends to misalign every level against the full-resolution image.

Pyramids are always written to a **different** store than the source. SpatialData
refuses to delete the files backing a live element, so there is no in-place mode.

### Other image notes

Labels are written with Blosc/zstd. Browser image codecs support `uint8`,
`int8`, `uint16` and `int16` only. A sidecar manifest records the expanded
config, per-raster stats, the codec backend used, and decoded checksums:

```bash
spatialdata-js-util images inspect output-htj2k.manifest.json
```

For repeatable multi-image runs, use a JSON config:

```json
{
  "default_image": { "codec": "imagecodecs_jpeg2k", "preset": "lossless", "chunks": "auto" },
  "images": {
    "morphology_focus": { "preset": "balanced" },
    "he_image": { "codec": "experimental.openjph_htj2k", "quality": 0.001 }
  },
  "default_labels": { "codec": "blosc", "clevel": 5 }
}
```

## Points

Morton-sorted Points Parquet, Vitessce-compatible:

- `morton_code_2d` added using 16 bits per axis
- the first 2–4 rows are sentinels with `morton_code_2d == 0` encoding the full
  point bounding box, so readers can get bounds without a scan
- `{feature_key}_codes` added when the element declares a `feature_key`
- string/categorical columns moved to the right of the table
- row-group size controlled, so a viewport maps to a few row-group reads

```bash
# List Points elements
spatialdata-js-util points list ~/data/xenium.zarr

# Morton-sort transcripts in place on points/<key>/points.parquet
spatialdata-js-util points morton-from-zarr ~/data/xenium.zarr --points-key transcripts

# Morton-sort a CSV or Parquet file
spatialdata-js-util points morton input.csv output.parquet --feature-key feature_name
```

Morton v1 belongs on the **canonical** element path `points/<key>/points.parquet`.
Use `--experimental` only for layouts standard readers cannot consume (see
[ADR 0002](../../docs/adr/0002-spatially-aware-vector-loading.md)).

`points index-permutations` builds a derivative store with several sort layouts
side by side for benchmarking. All of these are also available from the
[TUI](#interactive-tui), which verifies the output after each write.

## Tables

```bash
# Rewrite every table's X (and named layers) as CSC, in place
spatialdata-js-util tables to-csc ~/data/xenium.zarr

# Or write a converted copy, leaving the source alone
spatialdata-js-util tables to-csc input.zarr output-csc.zarr --overwrite
```

The conversion changes only the sparse layout, not the values, and the result
stays readable by any AnnData client. Dense matrices are left alone unless you
pass `--densify`, since sparsifying a dense matrix can make it bigger.

```python
from spatialdata_js_util import convert_store_tables_to_csc, to_csc

convert_store_tables_to_csc("store.zarr")     # whole store
csc = to_csc(adata.X)                         # or just a matrix
```

## Python API

```python
from spatialdata_js_util import (
    recompress_spatialdata,
    add_pyramids,
    has_pyramid,
    write_morton_points_parquet,
    convert_store_tables_to_csc,
    backend_report,
)

result = recompress_spatialdata(
    "input.zarr", "output-htj2k.zarr",
    codec="experimental.openjph_htj2k",
    preset="balanced",
    pyramid=True,          # add levels to single-resolution images first
    overwrite=True,
)
print(result.manifest_path)

# Or pyramids on their own
has_pyramid("input.zarr", "images", "morphology")   # -> False
add_pyramids("input.zarr", "output.zarr", levels=4)
```

## Monorepo development

From the repository root:

```bash
pnpm test:python
```

The vendored `openjph-wasm` assets under
`src/spatialdata_js_util/codecs/vendor/openjph/` are gitignored and produced by
`node scripts/vendor-openjph-for-python.mjs`, which `pnpm test:python` runs
first. They are only needed for the WASM backend; the `imagecodecs` backend works
without them.

Fixture-generation scripts under `scripts/` are repo-local and not shipped in the
wheel. To regenerate the backend probe fixture (requires Node.js):

```bash
uv run --directory python/spatialdata-js-util python scripts/build_htj2k_probe.py
```

TypeScript callers can use `encodeHtj2kPlane()` from `zarrextra` directly; see
[`docs/htj2k-wasm-encode-design.md`](docs/htj2k-wasm-encode-design.md).
