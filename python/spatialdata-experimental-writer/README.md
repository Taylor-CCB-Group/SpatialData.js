# spatialdata-experimental-writer

Experimental vector optimization writers for browser-oriented SpatialData
rendering.

The initial writer targets Vitessce-compatible Morton-sorted Points Parquet:

- `x`, `y`, optional `z` coordinates are preserved.
- `morton_code_2d` is added using 16 bits per axis.
- the first 2–4 rows are sentinel/extreme rows with `morton_code_2d == 0`;
  readers can infer the full point bounding box from these rows.
- `{feature_key}_codes` (for example `feature_name_codes`) are added when
  `feature_key` is set in element attrs.
- string/categorical columns are placed at the right side of the table.
- row-group size is controlled when writing Parquet.
- intermediate Morton uint columns are not persisted in the output Parquet.

Morton v1 belongs on the **canonical** element path
`points/<key>/points.parquet`. Use `--experimental` only for layouts that
standard readers cannot consume (see
[ADR 0002](../../docs/adr/0002-spatially-aware-vector-loading.md)).

Feature / gene filtering in the browser is documented in ADR 0002; pass integer
`featureCodes` through `@spatialdata/core` `loadPointsInBounds()` and
`PointsLayerConfig.featureCodes` in `@spatialdata/vis`.

## Install

```bash
cd python/spatialdata-experimental-writer
uv sync
```

For the interactive TUI:

```bash
uv sync --group tui
```

## Interactive TUI

```bash
uv run spatialdata-experimental-writer tui
uv run spatialdata-experimental-writer tui ~/data/xenium_rep1_io.zarr
```

The TUI wraps all writer commands:

1. Pick a command from the home menu.
2. Enter paths and options on guided forms (Zarr store path is pre-filled when
   passed on the command line).
3. Confirm before any in-place overwrite of canonical `points/<key>/points.parquet`.
4. Watch run output, then review post-write verification checks.

Morton verification checks after Morton writes:

| Check | Meaning |
|-------|---------|
| `column_present` | `morton_code_2d` column exists |
| `sentinel_prefix` | First 2–4 rows have `morton_code_2d == 0` |
| `sentinel_bbox` | Sentinel rows encode full dataset x/y bounds |
| `morton_monotonic` | Morton codes non-decreasing after sentinels |
| `row_group_sentinels` | Row group 0 contains only sentinel rows |
| `no_uint_intermediates` | No persisted `*_uint` staging columns |

Multiscale and index-permutation runs show schema/manifest checks instead.

## Commands

```bash
# List Points elements in a store
uv run spatialdata-experimental-writer list-points ~/data/xenium.zarr

# Morton-sort transcripts in-place on canonical points/<key>/points.parquet
uv run spatialdata-experimental-writer morton-points-from-zarr \
  ~/data/xenium.zarr --points-key transcripts

# Optional: write to points.experimental/ instead of canonical path
uv run spatialdata-experimental-writer morton-points-from-zarr \
  ~/data/xenium.zarr --points-key transcripts --experimental

# Build a derivative store with transcript index sort permutations
uv run spatialdata-experimental-writer write-index-permutations \
  ~/data/xenium_rep1_io.zarr \
  ~/data/xenium_rep1_index-permutations.zarr

# Morton-sort a CSV or Parquet file
uv run spatialdata-experimental-writer morton-points input.csv output.parquet \
  --feature-key feature_name
```

## Xenium workflow

Standard sandbox datasets are listed in the
[spatialdata datasets docs](https://spatialdata.scverse.org/en/stable/tutorials/notebooks/datasets/README.html):

| Dataset | URL |
|---------|-----|
| `xenium_rep1_io.zarr` | `https://s3.embl.de/spatialdata/spatialdata-sandbox/xenium_rep1_io.zarr/` |
| `xenium_rep2_io.zarr` | `https://s3.embl.de/spatialdata/spatialdata-sandbox/xenium_rep2_io.zarr/` |
| `visium_associated_xenium_io.zarr` | `https://s3.embl.de/spatialdata/spatialdata-sandbox/visium_associated_xenium_io.zarr/` |

After downloading a store locally:

```bash
uv run spatialdata-experimental-writer morton-points-from-zarr \
  ~/data/spatialdata/sdata_inputs/xenium_rep1_io.zarr \
  --points-key transcripts
```

This replaces `points/transcripts/points.parquet` in place (single-file output;
multipart source directories are replaced). Open the store in `@spatialdata/vis`
with `experimentalOptimizations="auto"` to use TileLayer row-group reads.

For sort-strategy benchmarks on a **copy** of the store:

```bash
uv run spatialdata-experimental-writer write-index-permutations \
  ~/data/spatialdata/sdata_inputs/xenium_rep1_io.zarr \
  ~/data/spatialdata/sdata_inputs/xenium_rep1_index-permutations.zarr \
  --max-rows 500000

uv run python scripts/benchmark_points_index.py \
  ~/data/spatialdata/sdata_inputs/xenium_rep1_index-permutations.zarr
```

## Multiscale hook

The package also includes a Padua-style multiscale Parquet writer that stores
`spatialdata_multiscale` JSON metadata in the Parquet schema. That layout is
non-standard for morton-points v1 and belongs under `points.experimental/` if
persisted.
