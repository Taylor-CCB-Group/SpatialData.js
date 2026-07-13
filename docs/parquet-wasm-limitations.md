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

## Runtime probe (2026-07-07): what the Vitessce build actually exposes

The `.d.ts` types `readMetadata` as `unknown` and our `ParquetModule` wrapper only
surfaces `numRows/fileOffset/compressedSize`, but the underlying wasm object
exposes **more** than the wrapper. Introspecting the live object:

- `ParquetMetaData`: `fileMetadata()`, `numRowGroups()`, `rowGroup(i)`, `rowGroups()`.
- `RowGroupMetaData`: `numColumns()`, `column(j)`, `columns()`, `numRows()`,
  `totalByteSize()`, `compressedSize()`, `fileOffset()`.
- `ColumnChunkMetaData`: `filePath()`, `fileOffset()`, `columnPath()`,
  `encodings()`, `numValues()`, `compression()`, `compressedSize()`,
  `uncompressedSize()`.
- **`ColumnChunkMetaData.statistics()` does NOT exist** — `col.statistics` is
  `null`. So per-column-chunk **min/max are not reachable** even though the parquet
  footer contains them (pyarrow reads them fine).

So the situation is more nuanced than "no column info":

- **Column-chunk *offsets* ARE available** (`column(j).fileOffset()` +
  `compressedSize()` + `columnPath()`). A projected byte range per column is
  computable. What still blocks a projected *fetch* is #804: `readParquetRowGroup`
  needs the *contiguous* row-group bytes, and hand-concatenating a subset of column
  chunks breaks the footer offsets — so we can compute the ranges but not feed a
  sparse buffer back in for decode.
- **Column *statistics* are NOT available.** This blocks the **feature-primary
  index** (skipping row groups whose feature range doesn't overlap the selected
  genes): we'd need per-row-group `feature_name_codes` min/max to pick the ~3 of
  245 row groups a gene lives in, and the wasm won't give them. Reading them via
  first/last-row reads (`loadParquetRowGroupColumnExtent`) fetches the *whole*
  row group each time — fetching the entire 449 MB file just to build the index.
  Getting stats efficiently needs one of: (a) a JS parse of the footer's Thrift
  `FileMetaData` for `Statistics.min/max_value`; (b) an alternative metadata reader
  (e.g. hyparquet, pure-JS, exposes row-group column stats); (c) extending the
  vitessce/parquet-wasm build to surface `.statistics()`; or (d) a sidecar
  per-row-group feature index emitted by the writer.

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
