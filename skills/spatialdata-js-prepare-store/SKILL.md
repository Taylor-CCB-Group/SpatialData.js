---
name: spatialdata-js-prepare-store
description: Make a SpatialData .zarr store fast to view in a web browser with SpatialData.js, using the spatialdata-js-util Python CLI. Recompresses images as HTJ2K/JPEG 2000, adds multiscale pyramids, Morton-sorts points Parquet, and converts table matrices to CSC. Use this whenever someone wants to view, share, publish or serve a SpatialData store (Xenium, MERFISH, Visium HD, CosMx and similar) in a browser, MDV, a notebook widget or a Claude tile, complains a store is slow to load or pan in the browser, or asks about spatialdata-js-util, HTJ2K or Morton-sorted points. This skill does not serve the store over HTTP; use spatialdata-js-host-store for that.
compatibility: Python 3.12+, a local filesystem copy of the store, and spatialdata >= 0.8 (installed by the `write` extra).
---

# Prepare a SpatialData store for browser reading

A browser can only afford a few small ranged reads per viewport. A store
written by `spatialdata` for Python use often needs whole-element downloads
instead. `spatialdata-js-util` fixes the three common causes:

| Element | Problem in the browser | Fix |
|---|---|---|
| images | Single-resolution rasters mean full-resolution reads when zoomed out. Generic compressors also decode slowly. | Add a pyramid, then recompress as HTJ2K or JPEG 2000. |
| points | Unsorted Parquet means downloading every row to draw any viewport. | Morton-sort with bounding-box sentinel rows and controlled row groups. |
| tables | CSR `X` means reading one gene's values scans every cell. | Convert `X` (and layers) to CSC. |

Shapes and anything not listed are copied through untouched.

## 1. Install

```bash
pip install 'spatialdata-js-util[write]'
```

If pip says the package does not exist (it may not be on PyPI yet), install
from the repository instead:

```bash
pip install 'spatialdata-js-util[write] @ git+https://github.com/Taylor-CCB-Group/SpatialData.js#subdirectory=python/spatialdata-js-util'
```

Then run `spatialdata-js-util codecs info`. `"selected": "imagecodecs"` means
HTJ2K works with no Node.js. If neither backend passes its probe, use
`--codec imagecodecs_jpeg2k` for images instead of HTJ2K.

## 2. Inspect before changing anything

```bash
python <this skill>/scripts/inspect_store.py path/to/store.zarr
```

This reads only metadata and Parquet footers. It never modifies the store. For
each element it prints the dtype, pyramid levels, codecs, points sort state, or
table matrix format, plus a `suggest` list naming the command that would help.
Use it to decide what to run. If no element has suggestions, the store is
already browser-ready and the next step is hosting.

Points worth checking in the output:
- **Image dtype.** Browser image codecs accept `uint8`, `int8`, `uint16` and
  `int16` only. Recompressing a store containing a `float32`/`float64` image
  fails partway. Leave those images out (see step 3).
- **`zarr_format: 2`.** The tool targets stores written by `spatialdata>=0.8`.
  If a command fails on a v2 store, re-save it first:
  `sd.read_zarr(old).write(new)`.

## 3. Run, writing a new store first

Image commands always write a new store. The points and tables commands
rewrite in place by default. So do images first into a new output, then run
points and tables on that output. The user's original stays untouched.

```bash
# Images: pyramid + HTJ2K into a new store (the slow step)
spatialdata-js-util images recompress in.zarr out.zarr \
  --codec experimental.openjph_htj2k --preset balanced --pyramid --overwrite

# Points: Morton-sort each element in place on the new store
spatialdata-js-util points morton-from-zarr out.zarr --points-key transcripts

# Tables: CSR -> CSC in place on the new store
spatialdata-js-util tables to-csc out.zarr
```

If no image needs work, the images step won't create the new store. In that
case run `tables to-csc in.zarr out.zarr` first, which copies, then
Morton-sort on `out.zarr`. Otherwise, before touching `in.zarr` in place,
confirm with the user that they have a backup.

### Choosing image options

- **`--preset`.** `balanced` (2 LSB step) suits viewing. `lossless` is for
  data someone will analyse from the browser copy. `small` trades visible
  quality for size. Lossy is a choice the user should know they made, so say
  which preset you used and why, and offer `lossless` if the browser copy may
  be used for measurement.
- **`--quality Q` is an absolute step, not 0–100.** It is relative to the
  dtype's full range. A step below one input LSB (`1/256` for 8-bit, `1/65536`
  for 16-bit) produces a larger file than lossless with no gain. Prefer the
  presets unless the user asks for a specific step.
- **`--sibling`.** Keeps each original image and adds a compressed copy next
  to it. HTJ2K is an experimental, non-standard OME-Zarr codec: it opens in
  SpatialData.js and in Python with this package installed, but other tools
  (napari, Vitessce, plain zarr readers without the package) cannot decode it.
  Use `--sibling` when the store will also be opened by those tools.
- **Ineligible images.** When any image is named, only the named images are
  recompressed; the rest are copied through unchanged. For one image, pass
  `--image-key <name>`. For several, use a `--config` file. Its `images` map
  lists the ones to recompress, and the command-line codec and preset flags
  still apply to them:

  ```json
  { "images": { "morphology_focus": {}, "he_image": { "preset": "lossless" } } }
  ```
- **`--pyramid`.** Only acts on single-level images larger than 1024 px on a
  side. For labels, use `images add-pyramid --labels`. It downsamples without
  averaging ids together.

`images recompress` also rewrites every labels element with Blosc/zstd. That
is lossless, and happens even when `--image-key` names only images, so mention
it in the report rather than letting the changed labels surprise anyone.

### If a command fails

A failed `images recompress` leaves a partly written output store. Delete it
before retrying, or the next run sees a half-copied store. Commands print JSON
on success and a Python traceback on failure. The last line of the traceback
usually names the element and the reason, for example the dtype.

## 4. Verify

Each command prints a JSON report and writes a manifest next to the output
store, named from the store's stem: `out.zarr` gets `out.manifest.json` from
the image commands and `out.csc-manifest.json` from `tables to-csc`. Read an
image manifest with `spatialdata-js-util images inspect out.manifest.json`. It
records the codec, backend, encode options and encoded size for each raster,
plus checksums for spot-checked chunks. It does not measure error. For lossy
presets, measure error against the original. This streams through dask, so
large images are fine:

```bash
python <this skill>/scripts/compare_images.py in.zarr out.zarr     # max/mean abs error per image
```

Then confirm:

```bash
python <this skill>/scripts/inspect_store.py out.zarr     # suggest lists should now be empty
```

```python
from spatialdata_js_util.verify import verify_morton_parquet, all_passed
checks = verify_morton_parquet("out.zarr/points/transcripts/points.parquet")
print(all_passed(checks), [(c.id, c.detail) for c in checks if not c.passed])

import spatialdata as sd
sd.read_zarr("out.zarr")      # opens, with HTJ2K images decoding transparently
```

Report the before and after sizes (`du -sh in.zarr out.zarr`), what each step
changed, and any element left alone and why.

## Next

To view the result in a browser, it has to be served over HTTP with range
requests and CORS. Plain `python -m http.server` does not do either. See the
`spatialdata-js-host-store` skill.
