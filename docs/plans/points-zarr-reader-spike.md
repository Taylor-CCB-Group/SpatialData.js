# Points: reading merfisheyes' multiscale points-zarr (spike)

Status: **spike; reader and writer working end to end, on synthetic stores and on a
1.19B-transcript Atera kidney section** (below). Not pushed.

merfisheyes stores points as Zarr v3 under `points/<name>/` ([spec draft 0.1][spec]):
nested uniform-sample levels, each holding the points in two orders (`tile_major`,
`feature_major`) plus a row-number index. It answers the two questions our Morton
parquet cannot: a zoomed-out view reads a uniform sample, not a prefix of the file, and
selecting a few genes reads only their rows.

It fits as one more encoding kind with no change to the resolver's shape:

- A copy sits beside the standard element, as its `experimental.points-zarr` subgroup
  (ADR 0006), so spatialdata and other standard readers still read `points.parquet`.
  `PointsElement.pointsZarrPath` names it; merfisheyes' own layout, where the element
  itself is the points-zarr group, is read too. The tiling probe returns a
  `PointsZarrTilingMetadata` (a new member of the `AnyPointsTilingMetadata` union), so
  with tiling on the resolver draws tiles from the copy; with it off, it preloads the
  standard parquet as before, which is how the two are compared on the same data.
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

`spatialdata-js-util points zarr` writes a store with a standard element and the copy
beside it, and `points add-zarr` adds the copy to an existing element (`points_zarr.py`,
out of core). merfisheyes' reference validator (`scripts/points_zarr.py validate`)
accepts the copy, and plain spatialdata reads the store.
`core/tests/pointsZarr.spec.ts` generates its store with it and checks the reader
against answers computed from the input points.

## Measured

On a synthetic 8M-point, 40-gene store written by merfisheyes' reference writer, level
selection behaves: zoomed out reads the coarsest level from `tile_major`, zooming in
moves to level 0, a rare gene is always read whole, and a gene selection reads only its
rows of `feature_major`.

On a real store: the Atera v1 WTA kidney section (1.19B transcripts, 24,674 genes),
read with spatialdata-io's atera reader and written as one SpatialData store: image,
labels, shapes, table and the standard `points.parquet`, with the points-zarr copy
beside it (written out of core: 26 min, 16 GB peak RAM, 7 levels, 3,813 files, 19 GB).
The whole store is 49 GB in 4,965 files and plain spatialdata reads it; as a STORED zip
it is one file, which our `ZipStore` opens in 4 reads, locally or over HTTP. Reads from
local disk, one call each:

| Read | Level | Points | Bytes |
|---|---|---|---|
| Open + gene catalog with counts | – | – | 0.4 MB |
| All genes, whole section | 6 | 289k | 2.0 MB |
| All genes, 512 µm tile | 2 | 274k | 6.2 MB |
| All genes, 128 µm tile | 0 | 161k | 3.6 MB |
| C7 (2.6M), whole section | 2 | 163k | 2.0 MB |
| Median gene (8k), whole section | 0 | 8k | 0.5 MB |

A view is every deck tile it covers, read as the layers strategy reads them: all genes,
tiles half the view's width, so 3×3 tiles. The cache is the element's own decoded-chunk
cache (`POINTS_ZARR_CACHE_BYTES`, 256 MB), passed to zarrextra's `getZarrChunk` per read.
It is filled only when chunks decode on the codec workers, as they do in the viewer; a
headless read on the main thread caches nothing:

| View (µm) | Tiles | Level | Points | No cache | Chunk cache | Held, decoded |
|---|---|---|---|---|---|---|
| whole | 4 | 6 | 289k | 6.9 MB, 84 requests | 2.0 MB, 36 requests | 4.6 MB |
| 4096 | 9 | 4 | 2.64M | 55 MB, 566 | 22 MB, 246 | 51 MB |
| 2048 | 9 | 3 | 3.08M | 58 MB, 649 | 26 MB, 313 | 63 MB |
| 1024 | 9 | 2 | 2.92M | 61 MB, 724 | 29 MB, 376 | 74 MB |
| 512 | 9 | 1 | 2.49M | 50 MB, 631 | 25 MB, 335 | 65 MB |
| 256 | 9 | 0 | 2.23M | 44 MB, 579 | 20 MB, 291 | 56 MB |

Zooming in 2048 → 1024 → 512 µm, panning half a view, and zooming back out costs
338 MB without the cache and 86 MB with it, holding 218 MB of decoded chunks; the way
back out reads nothing. A 128 MB cache makes it 123 MB, 64 MB makes it 142 MB.

In the viewer the section frames from 11 MB and a single gene shows its tissue pattern.
The same transcripts as spatialdata's standard `points.parquet` (30 parts of 540 MB, not
Morton-sorted) fetched 24 GB before the preload was stopped.

## What doesn't fit yet

- **Chunk granularity costs little now.** With the cache a view reads 7–10 B per point
  drawn, against about 6 B per row stored; smaller chunks in the writer would close the
  rest.
- **Requests.** A view takes about 300. merfisheyes' store merges neighbouring ranges of
  one shard into one request, which would cut that over HTTP; not done here.
- **Zoomed out, points vanish.** A coarse level is a sparse sample and our scatter's
  `radiusMinPixels` is 0.01; merfisheyes keeps molecules at least 1 px on screen.
- **The UI says "Morton".** The props panel labels the tile toggle "Viewport tiles
  (Morton)" and describes row groups.
- **The draft's version string.** The spec has its group declare
  `spatialdata_attrs.version: "0.3-zarr"`, a string from spatialdata's own list. Beside
  the standard element it is harmless, but worth raising with merfisheyes.
- **Storage.** A copy beside the standard element doubles the points: 16 GB of parquet
  and 19 GB of copy for the kidney section.
- **Spec stability.** Only `points:version` 0.1 is accepted. Their 0.2 proposals
  (tile-relative `uint16` coordinates) would need decoding here.
- Not done: hover/picking (no `id` → level-0 lookup), and 3-D rendering (`z` is read and
  carried, and `use3d` decides).

## Recommendation

Pursue it. The format removes both limits the parquet path has hit (no LOD; gene
selection saves no I/O), and at 1.19B transcripts it is the difference between a usable
view and an unusable one. Our resolver and strategy seams absorbed it without reshaping.
Next: a minimum point size; then raise the draft's version string and spec ownership
with merfisheyes and scverse.

[spec]: https://github.com/kresnajenie/merfisheyes/blob/main/docs/points-zarr-spec.md
