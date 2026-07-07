# parquet-wasm limitations (and what we'd ideally have)

**Status:** notes, 2026-07-07. Context for the points feature-filter perf work
(see [points MVP roadmap](plans/points-mvp-and-roadmap.md)).

We vendor [`parquet-wasm`](https://github.com/kylebarron/parquet-wasm) for all
browser parquet decoding (`packages/core/src/parquetWasmLoader.ts`,
`packages/core/vendor/parquet-wasm/`). It works well, but its API shape forces a
specific trade-off for large transcripts `points.parquet` files, and it's worth
recording precisely what it can and cannot do so we can evaluate alternatives
(different bindings, a patched build, or hand-rolled footer parsing) later.

## The capability we have

The normalized surface we rely on (`ParquetModule` in `parquetWasmLoader.ts`):

- `readParquet(fileBytes, { columns?, limit?, offset? })` — decode a **complete
  parquet file** buffer, with column **projection during decode**.
- `readParquetRowGroup(schemaBytes, rowGroupBytes, rowGroupIndex, { columns? })`
  — decode a **single row group** from its bytes + the file's schema bytes, again
  projecting columns during decode. This is what makes per-row-group range reads
  possible (`readParquetRowGroupBytesByGroupIndex` fetches
  `[rowGroup.fileOffset(), rowGroup.compressedSize()]`).
- `readMetadata(footerBytes)` → row-group metadata exposing **only**
  `numRows()`, `fileOffset()`, `compressedSize()` per row group
  (`ParquetWasmRowGroupMetadata`).

## The limitation that bites

**There is no way to fetch or decode an individual column chunk.** Consequences:

1. **No projected *fetch*.** Column projection (`{ columns }`) happens only
   *during decode*; the bytes handed to `readParquet` / `readParquetRowGroup`
   must be the **whole file** or the **whole row group** — i.e. *all* columns.
   For a 14-column Xenium `transcripts` file, building the feature catalog or the
   per-row feature codes (which need one string column) still downloads every
   column's bytes.
2. **No column-chunk offsets in the metadata.** `ParquetWasmRowGroupMetadata`
   does not expose per-`ColumnChunk` `file_offset` / `total_compressed_size` /
   `data_page_offset` / `dictionary_page_offset`. Without those we cannot compute
   the byte ranges of just the columns we want, so we cannot issue projected
   range reads even manually.
3. **Row-group bytes are not relocatable.** Per
   [kylebarron/parquet-wasm#804](https://github.com/kylebarron/parquet-wasm/issues/804)
   ("How to read a single row group batch, given only the row group bytes and the
   schema bytes"), the footer's byte offsets are absolute to the original file,
   so you cannot hand-concatenate a subset of column chunks into a synthetic row
   group and decode it — the offsets no longer line up. `readParquetRowGroup`
   sidesteps this by taking `schemaBytes` separately and the *contiguous* row-group
   bytes, but that means the whole (all-column) row group must be fetched.

The practical upshot: on a large transcripts file the cost is dominated by
**decoding** the feature/geometry columns, and the only lever we have to keep the
UI responsive is to move that **decode** off the main thread — *not* to fetch
less. We still fetch whole row groups (all columns) via async range reads, but
the CPU-heavy decode runs in the points worker. See the off-thread
geometry+features decode in `VPointsSource.loadPoints` /
`decodeGeometryWithFeaturesFromPayload`.

## What we'd ideally have

Roughly in priority order for our use case (points/transcripts):

1. **Column-chunk offsets in the metadata** — expose `ColumnChunkMetaData`
   (`file_offset`, `total_compressed_size`, `data_page_offset`,
   `dictionary_page_offset`) so we can compute per-column byte ranges. This alone
   unlocks projected fetching.
2. **A row-group decode that accepts a *sparse* set of column-chunk buffers**
   (chunk bytes + which column + within-row-group offset), so we can fetch only
   the columns we project and decode them without the whole row group. This is
   exactly the ask in #804.
3. **Dictionary-page-only reads** — for categorical columns (e.g. `feature_name`
   as `dictionary<int16>`), the distinct values live in per-row-group dictionary
   pages. Reading just those would build a feature catalog from a few KB per row
   group instead of decoding the full column.
4. **An async/range-read reader with random row-group access** that manages byte
   sourcing itself (custom store), so we don't shuttle raw bytes across the
   worker boundary.

We're open to evaluating alternative bindings or extending/patching the vendored
build to get (1)–(3); (1) is the highest leverage and smallest change. Until
then, off-thread decode (fetch-all-columns, decode-projected-off-thread) is the
pragmatic ceiling.
