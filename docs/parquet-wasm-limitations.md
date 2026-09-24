# parquet-wasm: what our build can and cannot do

**Status:** notes, updated 2026-09-24. Context for the points tiled-loading work
([plan](plans/points-morton-tiled-viewport-loading.md)).

We vendor a Vitessce CDN build of
[`parquet-wasm`](https://github.com/kylebarron/parquet-wasm) at
`packages/core/vendor/parquet-wasm/`, normalized behind `ParquetModule` in
`packages/core/src/parquetWasmLoader.ts`. We vendor rather than depend because that
build carries two APIs no published version has — and the entire byte-oriented read
path is built on them.

## Vendored build vs published 0.8.0

0.8.0 landed 2026-09-17. Read off the published tarball's `.d.ts` and the live
vendored module, not release notes:

| | vendored (Vitessce) | published 0.8.0 |
|---|---|---|
| `readParquetRowGroup(schemaBytes, rowGroupBytes, i)` | yes — but see (2) | **absent** |
| `readMetadata(footerBytes)` | yes | **absent** |
| `{ columns }` on `readParquet` / `readParquetRowGroup` | accepted and **ignored** | — |
| `ParquetFile.read` / `.stream`, from a URL or `Blob` | correct, dictionaries included | correct |
| …the same, projected with `{ columns }` | fetches less, **result unparseable** | works ([#904](https://github.com/kylebarron/parquet-wasm/pull/904)) |
| `ColumnChunkMetaData.statistics()` | no | no |
| `readParquet`, `readSchema`, `writeParquet`, `readParquetStream` | yes | yes |

**So the upgrade is a migration, not a version bump.** 0.8.0 has no byte-oriented
row-group reader at all: `readParquetRowGroup` and `readMetadata` exist *only* in the
vendored build. Everything that decodes a row group from bytes we fetched ourselves —
the Morton tiled scan, the progressive geometry preload, `VTableSource`'s capped reads —
runs on them, and works against any `zarr.Readable`. Moving to 0.8.0 means moving those
onto `ParquetFile`, which sources its own bytes and therefore needs a range-serving
http(s) origin (or a whole-file `Blob`).

It buys correct decoding past a dictionary column, and projection that genuinely cuts
bytes on the wire. It does not buy column statistics.

## The three facts that shape the current code

### 1. `{ columns }` is inert on the byte readers

Decoding row group 1 of the 12.17M-row `transcripts_morton` element to an IPC stream
gives **4,036,104 bytes** with no options, with `['x']`, with
`['x','y','morton_code_2d']`, and with a column name that does not exist — identical
every time, all 14 fields in the returned schema. `limit` *is* honoured, so the options
object is being read; `columns` specifically is ignored.

So every `{ columns }` in this repo is decorative, decode cost is always the full column
set, and a misspelled column name cannot fail a read.

### 2. `readParquetRowGroup` corrupts every field at or after the first dictionary column

Not just the dictionary column itself. Row group 3 of `transcripts_morton`, against
`pyarrow.read_row_group` as ground truth:

| # | field | type | decoded | truth |
|---|---|---|---|---|
| 0–9 | `x` … `morton_code_2d` | float/int | correct | correct |
| 10 | `feature_name` | `Dictionary<Int16, LargeUtf8>` | `null` | `ARFGEF3` |
| 11–12 | `cell_id`, `fov_name` | `LargeUtf8` | `""` | `fofoeonc-1`, `C3` |
| 13 | `__index_level_0__` | `Int64` | `-1` | `100004` |

`nullCount` is 0 for every column and nothing throws — the values are type defaults.
The schema survives intact; only the data is wrong.

It is not a string-only fault: a `Float32` written after a pandas categorical decodes as
`NaN`, from a `toArray()` **31 elements long against a reported `length` of 1000**. An
ordinary numeric column is unreadable purely because of its position. (This is the arrow
dictionary *type*, a pandas categorical — not pyarrow's `use_dictionary` *encoding*, so
the writer's encoding plan is unrelated.)

Probably the bug behind [#804](https://github.com/kylebarron/parquet-wasm/issues/804).
`resolvePassthroughColumns` (`packages/core/src/workers/pointsScan.ts`) refuses a
requested column at or after the boundary (`after-dictionary`) rather than serving it
wrong. Nothing served today crosses it — `overlaps_nucleus` (3), `qv` (6),
`nucleus_distance` (7) all precede `feature_name` (10) — so it guards a column order we
do not control, and `cell_id`, which sits on the far side.

### 3. No projected fetch, and no statistics

`ColumnChunkMetaData` gives `fileOffset()`, `compressedSize()` and `columnPath()`, so a
per-column byte range *is* computable. What blocks a projected fetch is
[#804](https://github.com/kylebarron/parquet-wasm/issues/804): the footer's offsets are
absolute to the original file, and `readParquetRowGroup` needs *contiguous* row-group
bytes, so a hand-concatenated subset of column chunks will not decode. Whole row groups
it is.

`ColumnChunkMetaData.statistics()` is absent from both builds, which would have blocked
the feature-primary index — picking the ~3 of 245 row groups a gene lives in. We parse
the footer's Thrift `FileMetaData` ourselves instead
(`packages/core/src/parquetFooterStats.ts`), so this one is worked around rather than
waiting on upstream.

## What moving to `ParquetFile` would settle

Verified on the vendored build, so none of this waits on 0.8.0 except the projection:

- **It decodes past the dictionary boundary.** The categorical fixture from (2), read
  unprojected through `ParquetFile.read({ rowGroups: [0] })`: every column full length
  and correct, `feature_name` included (`"A"`, not `null`).
- **It works under Node.** The comment on `supportsParquetStreaming()` in
  `parquetWasmLoader.ts` attributes the panic to the runtime; that is stale. It comes
  from the **server's range behaviour** — a 416, or a 200 that ignores `Range`. Against a
  server answering `bytes=A-B` and the suffix form `bytes=-N` with 206, `fromUrl`, `read`
  and `stream` all succeed under Node 24. Fixing that comment is tracked separately.
- **Projection needs 0.8.0.** On the vendored build `read({ rowGroups, columns })`
  fetches the smaller range and then returns the file's *full* schema against it, so
  `tableFromIPC` throws (`TypeError: Cannot destructure property 'length'`) — 7,256
  bytes served instead of 18,716, and no parseable table. Upstream
  [#810](https://github.com/kylebarron/parquet-wasm/issues/810), fixed by
  [#904](https://github.com/kylebarron/parquet-wasm/pull/904), released in 0.8.0. On a
  working build it projects to the wire: 0.47 MB against 2.93 MB for one row group of
  the real element (measured in the parquet byte-sourcing work). Note the trap — the
  wire bytes look like a win while the decode is broken, so a projection measurement has
  to **parse** the result, not just weigh it.

## Still missing from both builds

1. **`ColumnChunkMetaData.statistics()`** — the one we have already worked around, with
   our own Thrift parser.
2. **A row-group decode taking a *sparse* set of column-chunk buffers**, so a projected
   fetch could be decoded without the whole row group. This is the ask in
   [#804](https://github.com/kylebarron/parquet-wasm/issues/804).
3. **Dictionary-page-only reads** — a feature catalog from a few KB per row group
   instead of a full column decode.
4. **A byte-sourcing hook on `ParquetFile`** (a custom store rather than a URL), which
   is what would let the 0.8.0 reader serve a non-http `zarr.Readable` and make the
   migration above unconditional.
