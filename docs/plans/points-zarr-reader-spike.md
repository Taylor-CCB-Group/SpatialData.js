# Points: reading merfisheyes' multiscale points-zarr (spike)

Status: **spike, reader and writer working end to end on synthetic stores**. Not pushed.

merfisheyes stores points as Zarr v3 under `points/<name>/` ([spec draft 0.1][spec]):
nested uniform-sample levels, each holding the points in two orders (`tile_major`,
`feature_major`) plus a row-number index. It answers the two questions our Morton
parquet cannot: a zoomed-out view reads a uniform sample, not a prefix of the file, and
selecting a few genes reads only their rows.

It fits as one more encoding kind with no change to the resolver's shape:

- `PointsElement.storage` is `'points-zarr'` when the attrs carry `points:version`. The
  tiling probe returns a `PointsZarrTilingMetadata` (a new member of the
  `PointsTilingMetadata` union). The resolver plans tiling, then the catalog, and never
  a preload, exactly as for a Morton element. Parquet-only methods throw.
- `PointsZarrSource` (`core/src/pointsZarr.ts`) reads through zarrita 0.7, which handles
  their sharding, blosc, crc32c and `vlen-utf8` columns unchanged.
- The `'points-zarr-tiled'` loader picks a level per deck tile from the index alone:
  each feature gets the finest level whose *expected* count fits a share of
  `POINTS_TILE_TARGET_ROWS`, rarest feature first. The estimate is density × tile area,
  not the exact count in the tile, so every tile at one zoom picks the same level and
  there's no density seam. A tile clipped at the extent sizes its choice from the
  unclipped tile (`tileBounds`).
- The layers strategy is the Morton `TileLayer` path with a different grid
  (`multiscaleTileGrid`): one tile covers the extent at the coarsest zoom, and the
  finest tile is one level-0 grid tile.

Codes come from the format's enum and are identical across orders and levels, so the
dict-only code-space reconciliation does not arise. The catalog with exact counts costs
one read of `feature_rows`.

`spatialdata-js-util points zarr` writes the format (`points_zarr.py`, out of core), into
a store of its own because of the compatibility problem below. merfisheyes'
reference validator (`scripts/points_zarr.py validate`) accepts its output.
`core/tests/pointsZarr.spec.ts` generates its store with it and checks the reader
against answers computed from the input points.

## Measured

On a synthetic 8M-point, 40-gene store (levels 8M / 2M / 500k / 125k), written by their
reference writer and read from disk. Each view is all genes, every deck tile it covers:

| View (µm) | Tiles | Points | Bytes, no cache | Bytes, shared chunk cache |
|---|---|---|---|---|
| 8192 (whole) | 4 | 125k (level 3) | 1.8 MB | 0.7 MB |
| 2048 | 9 | 1.48M (level 0–1) | 44 MB | 19 MB |
| 1024 | 9 | 370k (level 0) | 23 MB | 7.9 MB |
| 512 | 9 | 92k (level 0) | 13 MB | 4.1 MB |

Level selection behaves: zoomed out reads level 3 from `tile_major`, and zooming in moves
to level 0. A rare gene is always read whole, and a gene selection reads only its rows of
`feature_major`.

On a real store: the Atera v1 WTA kidney section (1.19B transcripts, 24,674 genes; via
spatialdata-io's atera reader, then `points zarr` out of core: 26 min, 16 GB peak RAM,
7 levels, 3,813 files, 19 GB). Reads from local disk, one call each:

| Read | Level | Points | Bytes |
|---|---|---|---|
| Open + gene catalog with counts | – | – | 0.4 MB |
| All genes, whole section | 6 | 289k | 2.0 MB |
| All genes, 512 µm tile | 2 | 274k | 6.2 MB |
| All genes, 128 µm tile | 0 | 161k | 3.6 MB |
| C7 (2.6M), whole section | 2 | 163k | 2.0 MB |
| Median gene (8k), whole section | 0 | 8k | 0.5 MB |

In the viewer the section frames from 11 MB and a single gene shows its tissue pattern.
The same transcripts as spatialdata's standard `points.parquet` (30 parts of 540 MB, not
Morton-sorted) fetched 24 GB before the preload was stopped.

## What doesn't fit yet

- **Chunk granularity is the cost.** A level-0 `tile_major` chunk is 65,536 rows,
  about 6.5 mm of one grid row, so a 512 µm deck tile pays a whole chunk per column and
  its neighbour pays again: 60–140 B/point at fine zoom. merfisheyes' viewer amortises
  this with a 256 MB byte cache shared by every read and plans per view, not per deck
  tile. We need the equivalent: a chunk cache under the zarrita store, shared by the
  element's tiles (2.3–3× fewer bytes above). Smaller chunks in the writer are the other
  lever.
- **Range merging** (`mergeRanges`) only stops one read from fetching a chunk twice;
  it cannot help across tiles.
- **Feature colour fails above 16,384 features.** The colour lookup is a one-row texture
  as wide as the catalog; at 24,674 genes it exceeds `MAX_TEXTURE_SIZE` and every point
  draws uncoloured. Not specific to this format: any WTA element hits it.
- **Zoomed out, points vanish.** A coarse level is a sparse sample and our scatter's
  `radiusMinPixels` is 0.01; merfisheyes keeps molecules at least 1 px on screen.
- **The UI says "Morton".** The props panel labels the tile toggle "Viewport tiles
  (Morton)" and describes row groups.
- **Compatibility.** The element declares `spatialdata_attrs.version: "0.3-zarr"`, and
  their spec says spatialdata 0.8 then fails to read the whole store. A store that keeps
  `points.parquet` beside the Zarr element would stay readable. This reader would still
  prefer the Zarr form.
- **Spec stability.** Only `points:version` 0.1 is accepted. Their 0.2 proposals
  (tile-relative `uint16` coordinates) would need decoding here.
- Not done: hover/picking (no `id` → level-0 lookup), and 3-D rendering (`z` is read and
  carried, and `use3d` decides).

## Recommendation

Pursue it, behind the shared chunk cache. The format removes both limits the parquet
path has hit (no LOD; gene selection saves no I/O), and at 1.19B transcripts it is the
difference between a usable view and an unusable one. Our resolver and strategy seams
absorbed it without reshaping. Next: the chunk cache, the palette limit, a minimum point
size; then raise compatibility and spec ownership with merfisheyes and scverse.

[spec]: https://github.com/kresnajenie/merfisheyes/blob/main/docs/points-zarr-spec.md
