# @spatialdata/core

## 0.9.0

### Minor Changes

- [#132](https://github.com/Taylor-CCB-Group/SpatialData.js/pull/132) [`824576c`](https://github.com/Taylor-CCB-Group/SpatialData.js/commit/824576c2012e41ba0d628863f7acb0b671948a55) Thanks [@xinaesthete](https://github.com/xinaesthete)! - Bound the two parquet caches on `SpatialDataTableSource` by resident bytes
  ([ADR 0005](https://github.com/Taylor-CCB-Group/SpatialData.js/blob/main/docs/adr/0005-memory-accounting-before-management.md)
  rung 2), and add the `ByteLruCache` they are built on.
  
  `parquetTableBytes` (compressed file bytes) and `parquetTableCache` (decoded
  Arrow tables) were plain `Record`s with no eviction of any kind. A source held
  **both tiers of every parquet file any caller had ever touched**, simultaneously,
  until the source itself was discarded — double memory for zero eviction benefit.
  That is a leak, and this fixes it rather than building an architecture around it:
  both are now byte-bounded LRUs that report `byteLength`, and memory is
  assertable in a test for the first time.
  
  **Breaking for anyone reading those two fields directly.** They are no longer
  plain objects: `source.parquetTableBytes[path]` becomes
  `source.parquetTableBytes.get(path)`, with `peek` for a read that should not
  count as a use, plus `has`, `delete`, `clear`, `size` and `byteLength`. Nothing
  in this repository outside `VTableSource` touched either one.
  
  Ceilings default to 128 MB encoded and 256 MB decoded per source, overridable
  via the new `parquetCacheLimits` field on `DataSourceParams`. The numbers are
  guesses that bound a leak, not a measured working set — the ADR is explicit that
  they stay guesses until something measures them, so they are a constructor
  option rather than a constant you would have to fork the library to change.
  
  `ByteLruCache` also exposes `deleteIf(key, value)` and `recountIf(key, value)`,
  which act only while the entry is still the one the caller inserted. A late
  settlement — a decode that failed after its key was re-requested, or after
  eviction made room — must not reach in and resize or delete whatever took its
  place, and an unguarded `delete` there silently drops a live, valid entry. It is
  the same rule `VTableSource.evictIfCurrent` applies to its promise-keyed `Map`s,
  spelled for a cache whose reads carry recency.
  
  Two semantics worth knowing:
  
  - **A value larger than the whole budget is admitted, not refused**, and left as
    the sole resident. Refusing it would be the worse failure: `loadParquetBytes`
    runs roughly twenty times per points load, so a file that can never be admitted
    becomes twenty refetches of the file that was already too big to fetch once.
  - **Entries are inserted before their size is known.** The decoded cache holds
    the in-flight promise — that is what dedupes concurrent callers onto one WASM
    decode — so it is sized at zero until the table lands, then recounted. Arrow's
    `Data.byteLength` walks the whole child tree, so it is asked exactly once per
    table and the total is maintained incrementally from there.

- [#132](https://github.com/Taylor-CCB-Group/SpatialData.js/pull/132) [`824576c`](https://github.com/Taylor-CCB-Group/SpatialData.js/commit/824576c2012e41ba0d628863f7acb0b671948a55) Thanks [@xinaesthete](https://github.com/xinaesthete)! - Add `MemoryReporting` — `{ readonly byteLength: number }` — the first rung of
  [ADR 0005](https://github.com/Taylor-CCB-Group/SpatialData.js/blob/main/docs/adr/0005-memory-accounting-before-management.md).
  
  The library had a memory *policy* and no memory *accounting*: `DEFAULT_POINTS_MEMORY_CAP`
  is a row count applied to one element kind, and nothing anywhere could answer
  "how many bytes are resident right now?". This is that answer, and only that
  answer — no tiers, no eviction, no ceiling.
  
  The name is doing the work. `byteLength` is what `TypedArray`, `ArrayBuffer` and
  `DataView` already call this, so every payload we actually hold satisfies the
  interface structurally, with no wrapper and no import. That is what makes it
  cheap enough to put on every cache rather than on a chosen few.
  
  Implementors take on one obligation: keep the number cheap to read — a running
  total maintained on insert and evict, not a scan of the residents per read — so
  that callers can poll it freely.

- [#166](https://github.com/Taylor-CCB-Group/SpatialData.js/pull/166) [`eeb7785`](https://github.com/Taylor-CCB-Group/SpatialData.js/commit/eeb7785b30f87e1fd42aeff52cedf6b69c30e9ab) Thanks [@xinaesthete](https://github.com/xinaesthete)! - Load the vendored parquet-wasm through a package subpath, so it resolves in a
  consumer's production build.
  
  `@spatialdata/core/parquet-wasm` is now an export, and the loader imports it by that
  name. It used to reach the glue by relative path behind a `/* @vite-ignore */`, and
  both halves shipped: the comment told the consumer's bundler to skip resolution, and
  `../vendor/parquet-wasm/parquet_wasm.js` stayed in the published chunk. A consumer's
  build inlines that chunk into its own `assets/`, where the path means
  `{root}/vendor/…` — a file no build emitted. Every production build 404d on the first
  parquet read while dev worked, because a dev server serves core's `vendor/` tree out
  of node_modules. MDV had to copy that tree into its output (Taylor-CCB-Group/MDV#539);
  that workaround can go, along with the identical one in this repo's own
  production-browser harness.
  
  The consumer's bundler now resolves the subpath and emits the wasm as a hashed asset —
  one copy per bundle, no vendor directory to serve. Deleting the `@vite-ignore` alone
  would not have done it: `build.lib` inlines assets regardless of size, so bundling the
  glue here turns the 6.6MB wasm into base64 in an 8.8MB chunk, per format.
  
  The published package also drops `dist/vendor/`, its second copy of the wasm.

- [#166](https://github.com/Taylor-CCB-Group/SpatialData.js/pull/166) [`eeb7785`](https://github.com/Taylor-CCB-Group/SpatialData.js/commit/eeb7785b30f87e1fd42aeff52cedf6b69c30e9ab) Thanks [@xinaesthete](https://github.com/xinaesthete)! - **Breaking:** the points worker is now the parquet worker. It decodes and scans
  parquet for shapes as much as for points, so the old name described one caller. No
  aliases:
  
  | Before                          | After                              |
  | ------------------------------- | ---------------------------------- |
  | `@spatialdata/core/points-worker` | `@spatialdata/core/parquet-worker` |
  | `enablePointsWorker`            | `enableParquetWorker`              |
  | `disablePointsWorker`           | `disableParquetWorker`             |
  | `ensurePointsWorker`            | `ensureParquetWorker`              |
  | `isPointsWorkerEnabled`         | `isParquetWorkerEnabled`           |
  | `setPointsWorkerDefaultEnabled` | `setParquetWorkerDefaultEnabled`   |
  | `setPointsWorkerRequestTimeout` | `setParquetWorkerRequestTimeout`   |
  | `PointsWorkerRequest` / `Response` / `Message` | `ParquetWorkerRequest` / `Response` / `Message` |
  
  A worker that never loads is now detected instead of left to time out: an `error`
  from a worker that has not yet answered means it was never wired up, so it is
  switched off, `isParquetWorkerEnabled()` reports `false`, and callers take their
  main-thread fallbacks. A bad `workerUrl` now costs performance rather than a stall
  per request — except for `loadPointsMatchingFeatureCodes`, which has no fallback and
  throws immediately with a reason.
  
  New docs page, "Bundling into an application", covers the one thing a consumer must
  configure.

- [#155](https://github.com/Taylor-CCB-Group/SpatialData.js/pull/155) [`09bc5e9`](https://github.com/Taylor-CCB-Group/SpatialData.js/commit/09bc5e935281e1e9d4d67cd9d3a0aa5a1053a4bb) Thanks [@xinaesthete](https://github.com/xinaesthete)! - Points: render Morton-indexed elements from viewport tiles, on by default.
  
  A points element backed by a Morton-ordered Parquet artifact now draws through deck's
  `TileLayer`, reading row groups for the viewport, instead of a memory-capped resident
  preload. A 12.1M-point Xenium `transcripts` element can be explored at full detail, and
  the resident memory cap no longer applies to it. Tiles colour by feature, honour the
  feature filter inside the row-group scan, and subdivide with zoom.
  
  `pointsTiling` defaults to `'auto'`, so every points element is probed once and takes the
  tiled path if — and only if — it can. Read the config through `pointsTilingEnabled(...)`
  rather than comparing to `'auto'`: the default has to mean the same thing to the resolver
  deciding what to load, the hook deciding what to render, and the panel drawing the
  checkbox. `pointsTiling: 'off'` restores the previous behaviour per layer.
  
  **Why on rather than opt-in.** On a Morton artifact the capped preload is not a neutral
  alternative: it keeps the first `cap` rows in FILE order, and file order there is a prefix
  of the Z-curve — a spatially skewed chunk of the slide rather than a sample of it.
  
  **What it costs, measured.** At the default zoomed-out framing of that 12.1M-point
  element the tiled path loads all 44 tiles — 12,165,029 points / ~158 MB, the whole
  artifact — against a 4M-row prefix for the preload. First paint on a fully zoomed-out
  view is ~3x the rows, in exchange for a correct picture that streams in 44 pieces instead
  of blocking on one decode. Zooming OUT is the one direction viewport tiling does not
  help, because there is no coarser representation to read; that wants a multi-resolution
  points pyramid, not a finer index. An element that cannot be tiled is unaffected beyond
  one probe (4 range reads / ~2.16 MB), cached with its metadata.
  
  Applying a feature filter does **not** reduce I/O, and the plan's original expectation
  that it would has been corrected: row groups are chosen *spatially*, and a gene's points
  are spread across all of them. It cuts what is uploaded and drawn — one gene takes a
  viewport tile from 3,128,988 points to 87,594 — not what is read. Narrowing the fetch by
  feature needs a feature-primary index (the open question in ADR 0002/0003).
  
  **The tile grid is derived from the artifact.** It was one fixed level
  (`minZoom`/`maxZoom: -1`), so every tile was 1024 local units at every zoom, and 1024 came
  from deck's defaults rather than from the data. `mortonTileGrid` now derives both ends
  from point density: the finest level stays at least one row group's footprint, the
  coarsest holds at most 400k rows, and `zoomOffset = log2(modelMatrixScale)` couples deck's
  `z` to tile spans expressed in local units. `maxCacheSize` comes from a row budget rather
  than deck's `5 x the selected tile count`, which on a coarse viewport of this element
  could retain ~220 tiles / ~71M rows against a 4M resident cap. Accounting only — nothing
  evicts by bytes yet (ADR 0005). `PointsLoaderCapabilities` gains `totalRows` and
  `maxRowsPerGroup`, which the grid is derived from, and `mortonTileGrid` applies its
  documented default (the resident points memory cap) when no `cacheRowBudget` is given.
  
  Tiling is per LAYER but the probe's answer is cached per ELEMENT, so every consumer
  combines the two (`usesTiledPath`, `isTiledFor`). Reading the probe alone left a layer
  rendering tiles after the user switched tiling off, while planning went back to
  preloading — both at once.
  
  Per package:
  
  - **`@spatialdata/core`** — `PointsResolver` gains a `tiling` resource (a one-key
    `RequestSlot` holding the element's tileable Morton metadata, or `null` when it cannot
    drive tiles) and reports what a tiled entry actually has: no `preload` resource (absent,
    not idle, so `isBlocking` skips it), world `bounds` from the artifact's own extent so
    auto-fit can frame the layer before a tile loads, geometry status driven by the probe.
    `blockingResources` covers `tiling` as well as `preload`. `scanMortonTableInBounds`
    appends a feature code per point in lockstep with the geometry, and
    `loadMortonPointsInBounds` projects the code column whenever the artifact **has** one
    rather than only when a filter is active — the no-filter "all features" view was
    precisely the case that arrived without codes. `planPointsLoads` moves here from
    `@spatialdata/layers` (re-exported there; no consumer import moves), and
    `transformAxisAlignedBounds` is new.
  `PointsDataEngine.ensureTilingMetadata` is idempotent once the probe has settled: a ready
  `RequestSlot` answers with a fresh resolved promise, so a repeat call would otherwise churn
  the layer's status loading→ready and re-run the resident release. A *failed* probe stays
  retryable.
  
  - **`@spatialdata/layers`** — `mortonTiledStrategy`, and
    `PointsRendererAdapter.getTiledResource` memoised on (element, metadata): a new resource
    identity would make `TileLayer` refetch every visible tile, so a pan would become a full
    reload.
  - **`@spatialdata/vis`** — the tiled branch in `getLayers`, tiled world bounds,
    `hasRenderableLayerData` counting a tiled element as drawable, viewport-tile progress
    feeding `isLoading`, and `pointsTiling` / `showTileDebugOverlay` panel controls.
  
  Three things a tiled layer got wrong once it was actually drawing, also fixed here. The
  resident window is now released when the probe settles — `plan()` stops *asking* for a
  preload, which is not the same as evicting one — along with its row-aligned codes and
  feature-index scan, though the catalog stays, since it describes the element rather than
  the window. The panel's truncation notice no longer reads "4,000,000 of 12,165,021 points
  in memory — capped" directly above "the memory cap does not apply"; it says nothing, and
  the memory-cap control is hidden. And point sizing is one behaviour instead of two: the
  tile path sized in fixed pixels while the preloaded path used world units, so a zoomed-out
  tiled layer drew every one of its millions of points as a fixed screen dot, saturating
  density into a flat mass and hardening every tile seam into what looked like a rendering
  fault. Both paths now size in world units with the model-matrix scale folded in.
  
  A short feature-codes array is dropped rather than padded, on both paths: the remaining
  points would read code 0 — a *valid* feature — and be confidently mis-coloured, which is
  worse than no colour at all.

### Patch Changes

- [#132](https://github.com/Taylor-CCB-Group/SpatialData.js/pull/132) [`824576c`](https://github.com/Taylor-CCB-Group/SpatialData.js/commit/824576c2012e41ba0d628863f7acb0b671948a55) Thanks [@xinaesthete](https://github.com/xinaesthete)! - Give zarr imagery a decoded chunk cache
  ([ADR 0005](https://github.com/Taylor-CCB-Group/SpatialData.js/blob/main/docs/adr/0005-memory-accounting-before-management.md)
  rung 3). There was not one before — not an undersized one, none at all.
  
  fizarrita has always accepted a `{ get, set }` cache on `getWorker`, and
  `zarrextra` has always plumbed it through `enableWorkerChunkDecode({ cache })`.
  `ensureCodecWorkers()` called that with no options, so `cache` was `undefined`
  and fizarrita fell back to its no-op. The seam was exported, documented, typed
  end to end, and empty. Every tile therefore paid a network round-trip *and* a
  re-decode every time it came back into view.
  
  It is now filled with a byte-bounded LRU, default 256 MB, overridable with
  `ensureCodecWorkers({ chunkCacheMaxBytes })` on the first call. `getChunkCache()`
  returns it for inspection (`byteLength` is what it currently holds) or for
  `clear()`.
  
  `RasterElement.getStore()` is now memoized, and that is load-bearing rather than
  tidiness: fizarrita keys chunks as `store_N:{array path}:{chunk key}`, where `N`
  comes from a `WeakMap` on the **store instance**, and `createPrefixedStore`
  returns a fresh object literal on every call. Handing out a new view per caller
  would give one chunk a different key per view, so the cache would fill with
  duplicates and never hit. One stable view per element is what makes it a cache.
  
  Two things worth stating plainly about what ends up in there:
  
  - **Absent chunks are cached as data.** fizarrita materialises a full zero-filled
    typed array for a missing chunk and caches it like any other, so a sparse array
    can spend real bytes on nothing. The byte bound makes that survivable; it does
    not make it free.
  - **Concurrent readers of one chunk share a single fetch and decode.** fizarrita
    keys in-flight operations the same way it keys this cache, closing the window
    between "someone started fetching this" and "the result is cacheable". So the
    cache sees one write per chunk however many readers wanted it, and the byte
    total counts each chunk once.

- [#132](https://github.com/Taylor-CCB-Group/SpatialData.js/pull/132) [`824576c`](https://github.com/Taylor-CCB-Group/SpatialData.js/commit/824576c2012e41ba0d628863f7acb0b671948a55) Thanks [@xinaesthete](https://github.com/xinaesthete)! - Stop a transient parquet fetch failure from poisoning `loadParquetTable` for the
  lifetime of the source.
  
  `parquetTableCache` stores the table promise *before* it settles. That is
  deliberate and correct — it is what makes concurrent callers for the same file
  share one `readParquet` + `tableFromIPC` decode instead of racing two WASM
  parses of the same bytes. What was missing is the other half: nothing ever
  removed a promise that settled as a *rejection*. A single failed read — a
  dropped connection, a 503, a store not yet warm — left a rejected promise
  parked at that path forever, and every subsequent read of that element replayed
  a network error that had long since cleared. The only recovery was to construct
  a new source.
  
  The cached promise now evicts itself on rejection, and only if it is still the
  current entry for that path, so a retry that already superseded it is not
  clobbered by the earlier promise's late rejection. This is the same
  `evictIfCurrent` discipline `loadParquetDatasetMetadata` and
  `discoverMultipartPartPaths` already use.
  
  In-flight dedup and the caching of successful tables are unchanged, and so is
  the deliberate skip-vs-fail policy in `docs/plans/parquet-io-error-handling.md`:
  the rejection still propagates unchanged to the caller that provoked it. It just
  stops being the answer given to the next one.

- [#155](https://github.com/Taylor-CCB-Group/SpatialData.js/pull/155) [`09bc5e9`](https://github.com/Taylor-CCB-Group/SpatialData.js/commit/09bc5e935281e1e9d4d67cd9d3a0aa5a1053a4bb) Thanks [@xinaesthete](https://github.com/xinaesthete)! - Points (Morton): fix viewport queries silently dropping row groups, refuse to tile an
  artifact that only looks Morton-ordered, and stop the row-group search doing orders of
  magnitude more work than the query needs.
  
  Everything here is measured against a real 12.1M-point Xenium `transcripts` artifact
  (245 row groups) with a viewport-sized query rectangle.
  
  **Row groups were silently dropped — the holes in the tiled render.**
  `readParquetRowGroupColumnExtent` took a row group's last value with
  `readParquetRowGroup(..., { offset: rowCount - 1, limit: 1 })`, and the vendored
  parquet-wasm **ignores `offset` on a row-group read**: it returned the first row again, so
  every row group reported `max === min`. Nothing errored. The bisect asks "first row group
  whose max >= target", and an understated max moves that answer one group too far forward,
  so the row group that actually *contained* the interval start was never read — one
  viewport query lost **11 of the 92 matching row groups, 187,990 points (6%)**. The upper
  bound now comes from the sort order instead: a row group's values all lie at or below the
  next row group's first value. That is conservative, needs only the read that works, and
  halves the reads. The regression test asserts an exact point count rather than "more than
  zero"; this class of bug is silent by construction, and only a total sees it.
  
  **Row-group selection no longer reads the file at all.** `selectMortonRowGroups` picks
  from the per-row-group `[min, max]` the tiling probe parses out of the parquet footer. The
  bisect it replaces range-read the row group's BYTES — every column, ~2MB — to recover two
  boundary values, `log2(rowGroups)` steps per Morton interval. On one 1024 um viewport
  tile, both returning the same 643,961 points:
  
  | row-group selection | range reads | bytes | wall |
  |---|---|---|---|
  | bisect | 97 | 175.12 MB | 2911 ms |
  | footer index | 32 | 57.83 MB | 1035 ms |
  
  The remaining 32 reads are the row-group data itself. The footer path is also stricter:
  the bisect tested only `max` and assumed row groups tile the code space without gaps,
  while this intersects both ends. The bisect stays as the fallback when statistics will not
  parse, so this is an optimisation rather than a new requirement.
  
  **Two guards, because a file can carry the column and still not be Morton-ordered.**
  
  - *The sentinel box must be the domain the codes were quantised against.* Those rows are
    a claim the artifact makes about itself, and nothing in the file forces it to be true.
    Believing a wrong one does not fail — it clips the tile grid to the bogus box, so whole
    regions are never requested. `getPointsTilingMetadata` now recomputes `morton_code_2d`
    from x/y for a sample of real rows and requires a majority to agree: a sound artifact
    matches 320/320 sampled rows and one with a stale sentinel box matches 0/320, so the
    test is not marginal. The sample comes from the middle of the file, because a truncated
    box can agree with the true one near the origin by coincidence but never in the interior.
  - *The column must actually ascend.* A feature-primary artifact — sorted
    `(feature, morton)` — carries the identical column with identical, correct values, a
    correct sentinel box, and every field the probe looks for. Only the order is wrong, and
    nothing in the file said so, so the bisect landed arbitrarily and a tile came back
    holding whichever feature blocks lived in the row groups it picked: some tiles showed
    one or two genes, most showed none. The probe now requires the per-row-group `[min, max]`
    to be non-decreasing. On the permutations store,
    `transcripts_feature_then_morton` descends at 185 of its 244 boundaries while both
    morton-primary elements descend at none — including `transcripts_morton_then_feature`,
    so a *secondary* feature key stays supported and the test is on the file rather than on
    the element's name.
  
  Both gates fail CLOSED, which takes a third state: an extents list that is empty (no
  footer, a parse failure, a row-group count that disagreed) or entirely null (the column
  carries no statistics) is `'unverified'`, not `'sorted'` — see `mortonRowGroupOrderVerdict`.
  Reading either as sorted would pass a feature-primary artifact through the one gate that
  exists to stop it, and an all-null index is worse still, because every unknown extent is
  included and so every tile scans the whole file. An extent that is not a range at all
  (non-finite, or `min > max`) is rejected for the same reason: it cannot come from healthy
  statistics, so it means the decode is wrong.
  
  Both decline loudly and fall through to the capped preload. The sort check is free (the
  footer bytes are already in hand) and runs first, so a rejected element now costs less
  than before. `decodeUnsignedIntStat` is new: `morton_code_2d` is `uint32`, which parquet
  stores as INT32 with a UINT_32 annotation, and Morton codes use the top bit for real, so
  a signed decode reads the far corner of a slide as negative. `mortonCode2dForPoint` /
  `mortonBoundsAgreeWithCodes` are exported for the sentinel check, and pin the interleave
  convention (x in the even bits) that `zcoverRectangle` and the writer both already assumed
  without anything checking they stayed in step.
  
  **`zcoverRectangle` stops at `MORTON_ZCOVER_MAX_DEPTH` (10).** It recursed to the full 16
  bits per axis, resolving the rectangle to individual quantised cells when its only job is
  picking row groups — **38,014 intervals** to select 92 row groups. At the cap that is 521
  intervals selecting the **same 92 row groups**, verified over a viewport tile, the whole
  slide and a zoomed-in box. A coarser cell can only widen the covered code range, and the
  rows it brings in are filtered against the exact bounds after the read.
  
  Two internal consolidations, no behaviour change: `rowGroupFeatureCodeExtents` and
  `rowGroupMortonExtents` were the same footer walk twice and now share
  `rowGroupColumnStats`, with the decode left at each call site because that is the part
  that depends on the column's logical type. And the two row-group probes each hand-rolled
  "memoize the in-flight promise, but forget a `null` or a rejection"; they now share one
  `memoizeProbe` built on the existing `evictIfCurrent`, so a late settlement cannot clobber
  the retry that superseded it. That pins the half nothing covered — a failed extent probe
  must be retried, not remembered, or one transient read leaves the bisect treating a
  readable row group as unbounded for the life of the source.

- [#153](https://github.com/Taylor-CCB-Group/SpatialData.js/pull/153) [`ceaf2ef`](https://github.com/Taylor-CCB-Group/SpatialData.js/commit/ceaf2ef378cd72cca2ae472c5fe3cb8b20142027) Thanks [@xinaesthete](https://github.com/xinaesthete)! - Distinguish a feature that is fully loaded from one the memory cap only sampled.
  
  `resident` means a feature has **at least one** point inside the memory cap. On a
  truncated element that is true of nearly every feature, so the panel greyed nothing,
  showed each feature's full dataset count beside it, and presented a sample as the
  whole answer. On a Xenium transcripts element (8.07M points, 4M cap) all 541
  features read as resident while half the data was absent.
  
  `describeFeatureRowState` takes optional `residentPointCount` / `datasetPointCount`
  and returns a new `partial` tone — drawn, so not greyed, but labelled and explained
  with both counts and the share. A completed feature-index scan vetoes it: that
  supplies the feature whole, so its resident shortfall is no longer what is on screen.
  The built-in panel shows `resident / dataset` on those rows and a summary line, and
  falls back to the previous behaviour whenever counts are unknown.
  
  Fixes a latent bug this exposed: `getResidentFeatureCounts` answered from the preload
  result's own tally, which is frozen in the resident preview's code space and is not
  remapped when the full catalog supersedes it. For a dictionary-only element that
  attributed one gene's count to another. Counts now derive from the reconciled row
  codes, memoised on the same identity as the resident-codes set.

- [#166](https://github.com/Taylor-CCB-Group/SpatialData.js/pull/166) [`eeb7785`](https://github.com/Taylor-CCB-Group/SpatialData.js/commit/eeb7785b30f87e1fd42aeff52cedf6b69c30e9ab) Thanks [@xinaesthete](https://github.com/xinaesthete)! - Fall back to the main thread when the parquet worker rejects a shapes decode.
  
  `loadFlatShapeGeometry` handled the worker returning `null` — never enabled — but
  let a rejection propagate, so a request timeout, a worker that died mid-request, or
  one that failed to start between the enabled check and the post failed the whole
  element instead of decoding it on the main thread. Every other worker call site
  already caught. The catch is scoped to the worker call, so a genuine store read
  failure still surfaces as one.
- Updated dependencies [[`824576c`](https://github.com/Taylor-CCB-Group/SpatialData.js/commit/824576c2012e41ba0d628863f7acb0b671948a55), [`824576c`](https://github.com/Taylor-CCB-Group/SpatialData.js/commit/824576c2012e41ba0d628863f7acb0b671948a55)]:
  - zarrextra@0.5.0

## 0.8.0

### Minor Changes

- [#152](https://github.com/Taylor-CCB-Group/SpatialData.js/pull/152) [`223e066`](https://github.com/Taylor-CCB-Group/SpatialData.js/commit/223e066a97bc01560cce868fd7455d2bd73212fc) Thanks [@xinaesthete](https://github.com/xinaesthete)! - Report a failed feature-index scan instead of going quiet.

  `getMatchingLoadState` returned `undefined` for a failed `matching` slot — exactly
  what it returns for "no scan has ever run" — and nothing else exposed the error. So
  a scan that failed looked identical to one that had not started, while the render
  path carried on filtering the resident batch. The panel showed whichever part of the
  selection happened to be inside the memory cap and presented it as the complete
  answer.

  `PointsMatchingLoadState` gains `failed` and `error`, reported for the selection the
  failed scan would have covered (and only that one — a stale failure for a selection
  the user has since changed is not attributed to the new one, and a retained good
  batch no longer masks it). `usePointsFeatureState` gains `retryFailedLoads`, and the
  built-in feature filter panel now says the load failed, says the canvas is showing
  only what was already in memory, and offers Retry when the error is retryable.

### Patch Changes

- [#150](https://github.com/Taylor-CCB-Group/SpatialData.js/pull/150) [`dadcbf8`](https://github.com/Taylor-CCB-Group/SpatialData.js/commit/dadcbf81ea623c6e7b1b83728ff65faf1b2c3451) Thanks [@xinaesthete](https://github.com/xinaesthete)! - Emit the `workers` and `points-worker` entries as ES modules.

  The lib `fileName` named only `index` per format; every other entry got
  `${entryName}.js` from BOTH the es and cjs passes, so the cjs output silently
  overwrote the es one. `dist/workers.js` and `dist/points-worker.js` therefore
  shipped as CommonJS under a `.js` extension inside a `"type": "module"` package —
  files nothing can load.

  `enablePointsWorker` constructs the worker with `new Worker(url, { type: 'module' })`,
  so loading the published `points-worker.js` failed with `ReferenceError: require is
not defined` and the worker never answered. That made the points worker impossible
  to start outside this repo, and with it the feature-index scan: a points selection
  whose rows fall beyond the memory cap could not be fetched at all, because
  `loadPointsMatchingFeatureCodes` throws rather than falling back to the main thread.
  The demo did not catch it because it imports the worker's TypeScript source by
  relative path.

  Every entry now names its format, and `./workers` gains explicit `import`/`require`
  conditions. A packaging test asserts each `exports` target really is in the module
  system its extension and the package `type` imply.

## 0.7.0

## 0.6.0

### Patch Changes

- [#142](https://github.com/Taylor-CCB-Group/SpatialData.js/pull/142) [`a0a3cc4`](https://github.com/Taylor-CCB-Group/SpatialData.js/commit/a0a3cc456dfaa139d7afbe886acb872bfebad86e) Thanks [@xinaesthete](https://github.com/xinaesthete)! - Make a fill-colour column (or tooltip field) switch actually apply for a host that
  edits its layer configs in place.

  Two independent breaks sat between "the user picked a different column" and "the
  canvas shows it", and a host only hit them together. [#119](https://github.com/Taylor-CCB-Group/SpatialData.js/issues/119) fixed the third thing in
  that chain — the load-window blank — which is why the remaining two read as "the
  colours just never change".

  **The change never reached the resolver.** `useLayerData`'s reconcile effect is the
  one place a config change turns into a request, and it was keyed on the identity of
  `layers` and the configs inside it. That assumes the caller allocates a fresh config
  per edit; MDV's render-stack adapter deliberately does the opposite, keeping one
  `LayerConfig` per Stack Entry so a cosmetic edit does not look structural and
  re-enter geometry loads. Under that caller the effect never re-ran: the new column
  was never requested, `getShapeFillColorEntry` / `getLabelFillColorEntry` went on
  correctly serving last-good rows, and last-good was all there would ever be. The
  effect now also depends on `describeResolveInputs` — a value key over exactly the
  config fields each resolver's `plan()` reads, recomputed per render because a
  mutation is invisible to any memo. It holds scalars and short id lists only; a
  palette swap or an opacity drag does not move it, so nothing replans on a slider.

  **The settle never reached React.** `SpatialEntryStore` subscribed to its resolvers
  in its constructor and tore that bridge down in `dispose()` — which `useLayerData`
  calls from an effect cleanup. An effect cleanup is not "the end": StrictMode's dev
  double-mount runs cleanup and then re-runs the effect against the same memoised
  store, after which the store was permanently deaf to its own resolvers. Every async
  settle from then on was dropped, so rows that landed after a switch did not repaint
  until an unrelated re-render (a pan) came along. The bridge is now attached on the
  first listener and detached on the last, so it is exactly as long-lived as someone
  caring about it and survives any number of remounts. `getVersion()` became a derived
  sum of the resolvers' versions rather than a counter the bridge maintained, so it
  stays true whether or not anything is subscribed.

  No public API change. Verified against MDV driving only `fillColorByColumn` on a
  labels layer: switching to a column that has to be fetched now repaints on its own.

## 0.5.0

### Minor Changes

- [#105](https://github.com/Taylor-CCB-Group/SpatialData.js/pull/105) [`2c7e3c3`](https://github.com/Taylor-CCB-Group/SpatialData.js/commit/2c7e3c31ab3ce4c0fd509ff325bc8c02445fdfb0) Thanks [@xinaesthete](https://github.com/xinaesthete)! - Export runtime type guards and accessors for zarr tree nodes.

  `ZarrTree` admits a group or a `LazyZarrArray` at every key and shipped no way to tell
  them apart, so consumers hand-rolled the check — and the obvious `typeof node === 'object'`
  test is wrong, because a lazy array is an object too and its own properties (`get`) then
  read as child keys. `zarrextra` now exports the discrimination itself:

  - `isLazyZarrArray` / `isZarrGroup` — the guards, discriminating on `ZARRAY_KEY`.
  - `getChildNode` / `getChildGroup` / `getChildArray` — "the node at this path, if it is
    the kind I need", which is the shape most call sites actually want.
  - `getNodeAttrs` / `getArrayMetadata` — the symbol-keyed payloads of either kind of node.
  - `getArrayDtype` / `normalizeDtype` — the data type of an array node, from consolidated
    metadata alone, with v2's numpy typestrings (`<f8`, `|O`) and v3's names (`float64`,
    `string`) folded into one vocabulary: `zarrita`'s own `DataType`, so a check made
    against tree metadata and the same check made against an opened array cannot disagree.
  - `isTextDataType` — "do these values need decoding to strings", covering v3 `string`,
    v2 fixed-width unicode/bytes, _and_ `v2:object`. `zarrita`'s `isDataType(dtype, 'string')`
    excludes the last, and testing for one spelling without the other is what makes a
    reader hand back raw integer codes where labels were expected.

  `LazyZarrArray`'s `ZARRAY_KEY` payload is typed as `ZarrArrayMetadata` instead of an
  untyped record, so `dtype` and `data_type` can no longer be read without narrowing —
  reading the v2 spelling off a v3 node and silently getting `undefined` stops type-checking.

  `@spatialdata/core` re-exports all of the above and uses them throughout: `parsed` is
  narrowed to a group once in `AbstractElement`, so no element subclass sees the union, and
  `classifyObsColumnNode`, `getObsGroup` and `loadElements` drop their casts.
  `AnnDataSource` now asks `isTextDataType` about an opened array's dtype, so the
  classification a UI sees before loading a column and the decoding it gets when the column
  loads come from one definition.

  `readNullableArray`, `isNullableEncoding` and `NULLABLE_ENCODING_KINDS` are now public
  too. Guards make "is this group a categorical or a nullable column?" _expressible_; those
  make it _answerable_ without every consumer re-deriving AnnData's on-disk layout.

### Patch Changes

- [#109](https://github.com/Taylor-CCB-Group/SpatialData.js/pull/109) [`3215b3b`](https://github.com/Taylor-CCB-Group/SpatialData.js/commit/3215b3b5346f7f751a04f51a8a3d9e3623fa2505) Thanks [@xinaesthete](https://github.com/xinaesthete)! - Track spatialdata 0.8.0 in the fixture matrix; README quick-starts now point at
  `test-fixtures/v0.8.0/blobs.zarr`.

  No source changes — 0.8.0 reads correctly today. It does change the store on disk
  in two ways worth knowing about, both now covered by the integration matrix:

  - multiscale dataset paths are `s0`/`s1`/`s2` rather than `0`/`1`/`2`, so level
    names must come from `multiscales[0].datasets[].path` and never from position;
  - the AnnData `obs`/`var` index is written as a `nullable-string-array` _group_
    (a `values` array beside a `mask` array) instead of a plain `string-array`
    array. `loadObsIndex()` and the table source's `loadVarIndex()` both decode it.

  Note that `anndata.js`'s `varNames()` cannot read the new index at all — read var
  names through the table source, not the AnnData wrapper.

- Updated dependencies [[`423448b`](https://github.com/Taylor-CCB-Group/SpatialData.js/commit/423448b13e6a2cb07324faa9b318dca2c6ba1c59), [`2c7e3c3`](https://github.com/Taylor-CCB-Group/SpatialData.js/commit/2c7e3c31ab3ce4c0fd509ff325bc8c02445fdfb0)]:
  - zarrextra@0.4.0

## 0.4.0

### Minor Changes

- [#95](https://github.com/Taylor-CCB-Group/SpatialData.js/pull/95) [`baa54e9`](https://github.com/Taylor-CCB-Group/SpatialData.js/commit/baa54e9d25524901c6f33804da3b02d54bb89811) Thanks [@xinaesthete](https://github.com/xinaesthete)! - Decide continuous vs categorical from the column's declared kind, and let callers
  configure missing values.

  `TableElement.getObsColumnKinds` reports what the store says each obs column is —
  `numeric`, `categorical`, `string` or `boolean` — and `loadAssociatedTableFeatureRows`
  carries it alongside the values as `extraColumnKinds`. It is **synchronous**: opening a
  store already reads every node's attributes and array metadata into the tree, so a caller
  can ask what a column is before deciding whether to load it. Both zarr generations are
  read (v3 `data_type`, v2 numpy typestrings). `'auto'` mode now trusts that in
  preference to sniffing stringified values, which was wrong at both edges: one `NaN` made a
  float column look non-numeric, and integer cluster codes looked like a continuum. Value
  sniffing remains only as the fallback when no kind is available.

  `fillColorByColumn.missingValues` configures the rest: `treatAsMissing` adds
  store-specific sentinel strings (`'NA'`, `'unknown'`, …) that only the caller can
  recognise, and `render` chooses whether a feature with no value keeps the layer default,
  is hidden, or takes an explicit colour. `null` and `NaN` are always missing and are not
  configurable. Sentinels are excluded before the mode decision, the numeric extent and the
  category set, so a sentinel never becomes a category or drags a ramp.

- [#95](https://github.com/Taylor-CCB-Group/SpatialData.js/pull/95) [`baa54e9`](https://github.com/Taylor-CCB-Group/SpatialData.js/commit/baa54e9d25524901c6f33804da3b02d54bb89811) Thanks [@xinaesthete](https://github.com/xinaesthete)! - Add `featureState` to the labels sublayer schema, and export `SpatialLabelsSublayer`.

  `spatialLabelsSublayerSchema` now carries `fillColorByFeatureId`, `hiddenFeatureIds`,
  `fadedFeatureIds` and `filteredOpacityMultiplier` — the same field names and meanings
  `spatialShapesSublayerSchema` already had, keyed by the label's integer instance id as a
  string. It omits `strokeColorByFeatureId`: a label's outline is derived from its fill in
  the bitmask shader, so there is no per-label stroke to override.

  This closes the last place where a labels layer could not express what a shapes layer
  could.

- [#101](https://github.com/Taylor-CCB-Group/SpatialData.js/pull/101) [`1925695`](https://github.com/Taylor-CCB-Group/SpatialData.js/commit/1925695a15e1d354bc8100e55fb6bfca85bfc951) Thanks [@xinaesthete](https://github.com/xinaesthete)! - Read AnnData's nullable-encoded columns, and report their kind.

  A nullable column is a **group** of `values` + `mask`, not an array, so opening its
  path as an array fails outright. The visible symptom is usually a missing _index_
  rather than a missing value, because `obs/_index` and `var/_index` are ordinary
  columns — a table would load with `varN` in place of gene names, or with no row ids.
  This is not a legacy shape to tolerate: AnnData 0.13 defaults to zarr v3 and writes
  string columns this way by default, `_index` included, so it is what a freshly
  written `spatialdata` store looks like.

  All three nullable encodings are read (`nullable-string-array`, `nullable-integer`,
  `nullable-boolean`), with the mask honoured — a masked entry decodes as `null`, which
  the missing-value handling already treats as absent, so it stays distinguishable from
  a real `0` or `''` rather than being silently rendered as one.

  `getObsColumnKinds` recognises the same three. Without this the kind lookup fell
  through to array metadata that a group does not have and returned `undefined`,
  sending `'auto'` mode back to sniffing decoded values for exactly the columns AnnData
  now writes by default — the case that lookup exists to avoid.

  Also fixes zarr v3 categoricals decoding to their raw integer codes. The categories
  array is written as `string` on v3, and the text check tested for one v2 spelling of
  that dtype (`v2:object`), so the column resolved to codes — plausible-looking numbers
  rather than an error. The check now asks zarrita whether the dtype is text, which
  covers v3 `string` and v2 `U`/`S` alike, and pandas' `-1` missing code maps to `null`
  instead of indexing off the end of the categories.

### Patch Changes

- [#104](https://github.com/Taylor-CCB-Group/SpatialData.js/pull/104) [`0e0f2b5`](https://github.com/Taylor-CCB-Group/SpatialData.js/commit/0e0f2b5bd3a905c5cf4559ea80fe7017d195a083) Thanks [@xinaesthete](https://github.com/xinaesthete)! - Run the package unit tests in CI.

  `test:unit` was `vitest run --exclude tests/integration/**` with the glob
  unquoted, so the shell expanded it before vitest saw it. `--exclude` took the
  first match and the second became a positional filename filter, which meant the
  command ran exactly one file — the integration test it was meant to exclude —
  and no package unit test at all. CI reported that as a pass.

  Quoting alone would have surfaced 49 failures: the root config declared a single
  `node` environment for every file it collected, so the React hook tests in
  `react`, `vis` and `avivatorish` failed with `document is not defined`. They pass
  under `pnpm test`, which uses each package's own config.

  The root config now declares one project per package, so each runs under its own
  `vite.config.ts` and therefore its own environment, plus an `integration`
  project for the root suite. `test:unit` and `test:integration` select by project
  name rather than by glob. Both commands now agree with `pnpm test`: 788 tests
  across 95 files, where CI had been running 20.

- [#96](https://github.com/Taylor-CCB-Group/SpatialData.js/pull/96) [`886c6f2`](https://github.com/Taylor-CCB-Group/SpatialData.js/commit/886c6f2750998aaaf39c7ca617f048ecedade3bb) Thanks [@xinaesthete](https://github.com/xinaesthete)! - `TableElement.getObsColumnNames()` no longer reports the obs index as a column.

  The index array sits alongside the columns in the `obs` group, so it was being
  offered anywhere obs columns are listed — as `_index` for tables whose index is
  unnamed (the `blobs` fixture), which is AnnData's internal storage name rather
  than anything meaningful to a user. The name is now read from the `_index`
  attribute on the `obs` group and filtered out; the new
  `TableElement.getObsIndexColumnName()` exposes it for callers that want the
  index itself, alongside the existing `loadObsIndex()`.

## 0.3.1

## 0.3.0

### Minor Changes

- [#88](https://github.com/Taylor-CCB-Group/SpatialData.js/pull/88) [`6e153a6`](https://github.com/Taylor-CCB-Group/SpatialData.js/commit/6e153a6e3e7e564d31b835828615d8145b6bc805) Thanks [@xinaesthete](https://github.com/xinaesthete)! - Non-blocking shapes loading + a vertex-pulling `FlatPolygonLayer`.

  Shapes no longer gate first paint. The geometry column is decoded (WKB → flat buffers)
  **and tessellated** into render topology inside the geometry worker and transferred back
  zero-copy; `ShapesResolver.blockingResources` is now `[]`, and a main-thread tessellation
  fallback covers the no-worker path. This removes the full-element main-thread WKB decode
  that previously blocked behind the "Loading layer data…" overlay, and it lets Visium HD
  `square_002um` (~2.7M polygons) load without running out of memory.

  Polygon shapes now render through a new hand-rolled `FlatPolygonLayer`
  (`@spatialdata/layers`) instead of deck's `SolidPolygonLayer` + a `PathLayer` outline:

  - **Vertex pulling** — an attribute-less draw where the vertex shader reconstructs each
    vertex's position and a boundary edge-distance from two shared geometry textures via
    `gl_VertexID`, and imputes an anti-aliased outline with `fwidth` in the fragment shader
    (no separate outline layer). Per-frame cost ≈ the fill; geometry memory ≈ the stock
    indexed fill. Works on arbitrary polygons (cell segmentation, not just grids).
  - **Feature state via a per-feature colour texture** (the reusable "table column →
    buffer" primitive): colour-by-column, hide, and fade re-upload only a small texture,
    never the geometry buffers. Picking colours are computed in-shader from the feature
    index.
  - **Outline** is a lightened derivation of the fill, width-capped to a fraction of each
    shape's on-screen size and faded out for sub-pixel shapes — clear when zoomed in,
    non-dominating (no moiré) when zoomed out.

  New/changed public surface: `@spatialdata/core` exports `tessellateFlatPolygons` /
  `TessellatedPolygons` and carries the tessellated topology on `ShapesRenderData`;
  `@spatialdata/layers` exports `FlatPolygonLayer`. `@spatialdata/vis` decouples the
  one-shot auto-fit from the shapes-blocking transition so a shapes-only view still frames
  correctly.

  Also fixes a fill-colour "one column behind" bug (the feature-state runtime cache is now
  keyed on the fill-colour entry identity, not just its column signature); the hover/pan
  buffer-thrash from unstable deck `updateTrigger` arrays; and a per-feature colour-buffer
  thrash where two shapes layers sharing the default feature-state runtime rebuilt each
  other's (million-element) colour buffer on every frame — the `FlatPolygonLayer` colour
  cache is now keyed per layer.

  Known follow-ups: the main-thread GPU texture upload (~seconds on the largest elements)
  is not yet off the main thread — a WGSL/WebGPU variant (storage buffers instead of
  texture-packing) is the intended fix; explicit per-feature stroke override on the polygon
  path; non-blocking associated-table load.

### Patch Changes

- [#89](https://github.com/Taylor-CCB-Group/SpatialData.js/pull/89) [`e94ba97`](https://github.com/Taylor-CCB-Group/SpatialData.js/commit/e94ba97d472bce02dc2efc4c561e478ed42645de) Thanks [@xinaesthete](https://github.com/xinaesthete)! - Points: feature selection now works on large elements, and persists by name.

  **Selections persist as feature names.** `PointsLayerConfig.featureNames` is the
  durable, serializable form and what the UI writes. Codes are app-assigned for a
  dictionary-only element (a Xenium `transcripts` has `feature_name` and no code
  column), so a stored code could silently come back meaning a different feature.
  `featureCodes` still works and still takes effect at runtime, but names win when
  both are present. `resolveFeatureSelectionCodes` / `featureNamesForCodes` are
  exported from `@spatialdata/core` for converting between the two.

  **The feature scan now completes on large elements.** Previously, selecting a
  feature on a multi-million-row element frequently never resolved — the scan
  plateaued part-way through and the layer sat there. It now reads through
  `ParquetFile.stream({ columns, rowGroups })`, which fetches per column chunk, so
  the projection reaches the network instead of pulling whole row groups — all 12
  columns of a Xenium `transcripts` to use three. The scan runs in the points
  worker, keeping the parquet decode off the main thread. Selecting one gene from a 12.1M-row element now
  settles in ~1.0s, with main-thread time roughly a third of what the pre-streaming
  path cost.

  Also fixed along the way: a full-dataset catalog scan being silently cancelled by
  the resident preview settling underneath it (leaving counts stuck and colours
  mismatched); row-group chunks handing out the cached footer buffer, which the
  worker transfer detached (`DataCloneError`, dropping the element onto whole-file
  reads); parquet part layout being re-probed on every call; a server that answers
  a directory path with 500 rather than 404 wedging part traversal; and point size
  not accounting for an element's transform scale.

  Known limitation: for a dictionary-only element the fallback catalog path cannot
  tally per-feature counts, and it settles _successfully_ without them — so the
  retry path does not repair it and counts stay absent for the session. Names and
  selection are unaffected. Treat a missing count as unknown, not zero, and do not
  read the presence of counts as a signal that the scan completed.

- [#80](https://github.com/Taylor-CCB-Group/SpatialData.js/pull/80) [`ab1b809`](https://github.com/Taylor-CCB-Group/SpatialData.js/commit/ab1b80989b66e27950f74b503c91348b90b60827) Thanks [@xinaesthete](https://github.com/xinaesthete)! - Points/transcript rendering: composite layer, loading engine, and size controls.

  Points elements render through the `@spatialdata/layers` `PointsLayer` composite
  (ADR 0003) via a store-agnostic `resolvePointsRenderResource` boundary, backed by
  a new React-free `PointsDataEngine` that owns points loading, caching, and
  render-resource resolution. `@spatialdata/core` gains the points I/O foundation
  (bounded/capped loading, Morton tiling metadata, feature catalog, an opt-in
  worker, and vendored parquet-wasm with row-group range reads). SpatialCanvas adds
  a point-size control; preloaded points are sized in world units so they scale
  with zoom, clamped to a pixel range.

- Updated dependencies [[`e343a72`](https://github.com/Taylor-CCB-Group/SpatialData.js/commit/e343a721ce949fd9592c8ead2edec9a238f70f92)]:
  - zarrextra@0.3.0

## 0.2.5

### Patch Changes

- Updated dependencies [[`c5e6deb`](https://github.com/Taylor-CCB-Group/SpatialData.js/commit/c5e6deb3c5f621844302c80ae92603b3f70cacf3)]:
  - zarrextra@0.2.3

## 0.2.4

## 0.2.3

## 0.2.2

### Patch Changes

- Updated dependencies [[`c84758c`](https://github.com/Taylor-CCB-Group/SpatialData.js/commit/c84758c780db65737a7978231586ea7d99e1d4fb)]:
  - zarrextra@0.2.2

## 0.2.1

### Patch Changes

- Updated dependencies [[`4e58f28`](https://github.com/Taylor-CCB-Group/SpatialData.js/commit/4e58f28f585ab4e95f0057cba1b27ce75045402a)]:
  - zarrextra@0.2.1

## 0.2.0

### Minor Changes

- [#48](https://github.com/Taylor-CCB-Group/SpatialData.js/pull/48) [`e20648d`](https://github.com/Taylor-CCB-Group/SpatialData.js/commit/e20648df7ba22b869949b684ab70348978eb8774) Thanks [@xinaesthete](https://github.com/xinaesthete)! - Add support for alternative codecs in zarrextra, with tooling to encode images as JPEG2000 and HTJ2K.

  Zarrita stores can be configured to decode in workers.

### Patch Changes

- [#47](https://github.com/Taylor-CCB-Group/SpatialData.js/pull/47) [`faf55cf`](https://github.com/Taylor-CCB-Group/SpatialData.js/commit/faf55cf9988e0a82449f5dcd3b75c01aa6550587) Thanks [@xinaesthete](https://github.com/xinaesthete)! - Fix schema to allow for tables without association to spatial elements.

- Updated dependencies [[`e20648d`](https://github.com/Taylor-CCB-Group/SpatialData.js/commit/e20648df7ba22b869949b684ab70348978eb8774)]:
  - zarrextra@1.0.0

## 0.1.0

### Minor Changes

- [#42](https://github.com/Taylor-CCB-Group/SpatialData.js/pull/42) [`0a73939`](https://github.com/Taylor-CCB-Group/SpatialData.js/commit/0a73939691b44b44204842e3d408a8d1114c2212) Thanks [@xinaesthete](https://github.com/xinaesthete)! - Prepare the first MDV-targeted alpha prerelease.

### Patch Changes

- Updated dependencies [[`0a73939`](https://github.com/Taylor-CCB-Group/SpatialData.js/commit/0a73939691b44b44204842e3d408a8d1114c2212)]:
  - zarrextra@0.1.0

## 0.1.0-next.0

### Minor Changes

- [#42](https://github.com/Taylor-CCB-Group/SpatialData.js/pull/42) [`0a73939`](https://github.com/Taylor-CCB-Group/SpatialData.js/commit/0a73939691b44b44204842e3d408a8d1114c2212) Thanks [@xinaesthete](https://github.com/xinaesthete)! - Prepare the first MDV-targeted alpha prerelease.

### Patch Changes

- Updated dependencies [[`0a73939`](https://github.com/Taylor-CCB-Group/SpatialData.js/commit/0a73939691b44b44204842e3d408a8d1114c2212)]:
  - zarrextra@0.1.0-next.0
