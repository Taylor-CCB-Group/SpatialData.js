# Points: Morton-tiled viewport-driven loading (D5)

Status: **complete** (2026-08-12) — live end to end, D5 closed in the punch-list.
What is deliberately still open is under [Still open](#still-open).

Implements [points-redesign-punchlist](./points-redesign-punchlist.md) **D5** and the
"Morton is still dark" line in [points-mvp-and-roadmap](./points-mvp-and-roadmap.md).
Format contract: [ADR 0002](../adr/0002-spatially-aware-vector-loading.md). Encoding →
strategy: [ADR 0003](../adr/0003-points-render-resource.md). Substrate:
[ADR 0004](../adr/0004-resource-resolver-owned-by-core.md) /
[layer-data-engine-decomposition](./layer-data-engine-decomposition.md). Per-element path
table: [points-preload-feature-filter-status](./points-preload-feature-filter-status.md).

---

## The point

A Morton-sorted points artifact lets us read **only the row groups whose Morton interval
intersects the viewport**, so a 12M-row transcripts element renders without ever holding
12M rows. The preload it replaces keeps the first *N* rows in **file** order — which on a
Morton artifact is a prefix of the Z-curve, i.e. a spatially skewed chunk of the slide
rather than a sample of it. Tiles read what is in view.

Nothing here was a rewrite: the interval maths, the row-group reads, the in-bounds scan
and the `TileLayer` strategy all existed and were tested. What was missing was the
wiring, and its home had moved from a React hook to a resolver. (Before D5:
`PointsRendererAdapter` hardcoded `experimentalOptimizations: 'off'`, nothing called
`getPointsTilingMetadata`, so `mortonTiledStrategy` was unreachable.) Harvested from
`backup/points-wip-20260702`; `PointsStylePanel` and the old `pointsRenderer` tiled
branch were deliberately **not** taken, both superseded on main.

## Where the code is

Plain file links, deliberately without line numbers — those rot.

| | |
|---|---|
| Morton intervals, sentinel handling, bounds/codes agreement check | [`core/pointsTiling.ts`](../../packages/core/src/pointsTiling.ts) |
| Row-group selection from footer statistics, tile grid | [`core/pointsTileGrid.ts`](../../packages/core/src/pointsTileGrid.ts), [`core/parquetFooterStats.ts`](../../packages/core/src/parquetFooterStats.ts) |
| Metadata probe, row-group reads, in-bounds scan | [`core/models/VPointsSource.ts`](../../packages/core/src/models/VPointsSource.ts) (`getPointsTilingMetadata`, `loadMortonPointsInBounds`) |
| Resolver slots and planning | [`core/engine/PointsResolver.ts`](../../packages/core/src/engine/PointsResolver.ts), `planPointsLoads` |
| Worker tile scan | [`core/workers/pointsScan.ts`](../../packages/core/src/workers/pointsScan.ts), `parquet-worker.ts` |
| `TileLayer` strategy, debug overlay | [`layers/mortonTiledStrategy.ts`](../../packages/layers/src/mortonTiledStrategy.ts), `pointsTileDebug.ts` |
| Encoding → strategy table, adapter | [`layers/pointsRenderStrategies.ts`](../../packages/layers/src/pointsRenderStrategies.ts), `adapters/PointsRendererAdapter.ts` |
| Writer | [`spatialdata_js_util/points.py`](../../python/spatialdata-js-util/src/spatialdata_js_util/points.py), `index_permutations.py` |

## What shipped

- **A `tiling` slot on `PointsResolver`**, keyed `'probe'`, where `null` is a settled
  fact ("not tileable") rather than an absence — the same shape the catalog uses for a
  `feature_key`-less element. The preload became conditional on the probe's answer via
  `planPointsLoads` (moved to `core`, since `core` cannot import from `layers` and a
  duplicated decision is how the two drift); a failed probe settles `null`, stays
  retryable, and still lets the fallback preload run. Config: `pointsTiling?: 'auto' |
  'off'`.

  Row codes and the matching scan have to wait on the **pending** probe too, not just on
  `isTiled` — the tests found this. Planning them while it is in flight does the wasted
  read *and settles the codes*, so the next pass reads "already loaded" and the waste
  becomes invisible: exactly the shape of bug the deferral exists to prevent. `plan()`
  returns early on `probeMetadata || isTiled`.
- **`blockingResources` varies with entry state** (`['tiling']` until the probe settles,
  then `['preload']` or `[]`). It could not stay a constant: a tiled entry never plans a
  preload, so that slot would sit `idle` forever and the canvas would never leave
  "Loading layer data…". Note **auto-fit piggybacks on the `isBlocking` true→false
  transition** — the trap that bit the shapes non-blocking pass. The rejected
  alternative was settling `preload` to a "not applicable" sentinel, which would have
  put a lie in the slot every later reader of the resident-batch invariants would trip on.
- **An identity-stable tiled resource** from the adapter, memoised on
  `(element, metadata)`. Not cosmetic: a fresh resource per `project()` tears down the
  `TileLayer` and re-fetches every visible tile.
- **Bounds, framing and progress** from `tilingMetadata.bounds` rather than a resident
  batch, with "tileable metadata settled" counting as renderable. `isBlocking` stays
  false once metadata is known — tiles refine an already-framed layer.
- **Per-tile feature codes and colour.** `loadMortonPointsInBounds` used to filter by
  feature code and then discard it, so a tiled batch had no `featureCodes` and
  colour-by-feature, the palette LUT and Feature Highlight all degraded silently to flat
  colour; `mortonTiledStrategy` did not forward the colour props either. Both fixed, and
  the code column is projected whenever the artifact HAS one rather than only when
  filtering — the no-filter "all features" view was precisely the case arriving without
  codes. A short codes array is **dropped rather than padded**: the tail would read code
  0, a valid feature, and be mis-coloured with conviction.

  `rowCodes` is excluded on the tiled path — its gate reads the first `min(rowCount,
  cap)` rows in file order to align with a resident batch that does not exist. `renderCap`
  stays unset, being a resident-window notion when a tile is already bounded by its
  viewport. The feature-row panel needed a tiled case of its own, since every other signal
  it reads describes a resident batch: its rows fell through to "beyond the resident
  window; select it to fetch its points", greyed and wrong twice.
- **The catalog is planned for a tiled entry**, not inherited. On the preloaded path it
  arrives free as a preview off the geometry decode; a tiled entry never decodes a
  resident batch, and the selection is stored as feature **names**, which cannot become
  codes without it — so a saved config with a selection would have drawn every feature
  until someone opened the panel. A failed catalog is not re-planned (`retry()` is the way
  back), or the task re-emits forever. The selection also rides `getTileData`'s
  `updateTriggers`, so changing it refetches rather than serving the previous selection's
  tiles.
- **A grid derived from the artifact** ([`pointsTileGrid.ts`](../../packages/core/src/pointsTileGrid.ts)),
  and a cache budgeted in rows. See [the grid](#the-grid-comes-from-the-artifact).
- **`pointsTiling` defaults to `'auto'`** (`DEFAULT_POINTS_TILING`), read everywhere
  through `pointsTilingEnabled` so `undefined` cannot mean one thing to the resolver and
  another to the panel. The panel keeps the toggle and hides the memory cap, which
  governs nothing on a tiled layer.

## What the measurements showed

### Two claims the artifact makes about itself, neither of which was checked

**The sentinel bounding box.** `metadata.bounds` is the Morton quantisation domain for
`mortonIntervalsForBounds`, and the `TileLayer` extent is clipped to it, so a wrong box
maps every viewport to the wrong intervals *and* shrinks the grid. Two of the four
elements in the 2026-08-12 permutations store carried a sub-box while their codes had
been quantised against the full extent — the two disagreed inside the same file, and the
symptom was the top half of the tissue never being *requested*: no pending tile, nothing
to wait for. Points are never misplaced (the scan re-filters to the requested bounds), so
the failure is silently **subtractive**, the same shape as the bisect bug fixed in
`6cfe7bb`. The store was regenerated; today's writer never had the bug.

The reader now **recomputes `morton_code_2d` from x/y** for a sample of real rows, taken
from the middle of the file, and refuses to tile unless a majority agree
(`mortonBoundsAgreeWithCodes`). That tests the invariant that matters — *is this box the
quantisation domain?* — not a convention, so a deliberately padded domain still tiles.
Cost: one extra row-group read per element, cached with the metadata (414 → 523 ms, 3 → 4
range reads, 0.37 → 2.16 MB). Only positive evidence of disagreement disables tiling.

**The sort.** A `morton_code_2d` column does not make a file Morton-*sorted*.
`transcripts_feature_then_morton` carries the identical column with correct values, a
correct box, and every field the probe looks for; only the order is wrong, and nothing in
the file says so. The bisect binary-searches that index assuming it ascends, so it landed
arbitrarily and a tile came back holding whichever feature blocks lived in the row groups
it picked — that was "some tiles pick up one or other feature, most miss". Read from
footer statistics the two are unmistakable: 0 descents in 244 row groups for
`transcripts_morton` *and* for `_morton_then_feature` (a secondary feature key is
harmless, which is why this must be measured rather than inferred from the element name),
against **185** for the feature-primary file. The check is free — the footer bytes are
already in hand — and failing it skips the sampling read too, so a rejected element costs
less than before. The column is `uint32` and Morton uses the top bit, so the statistics
must be decoded **unsigned**.

Under-selection has now bitten this path four times (`zcover` depth, the row-group
bisect, the sentinel box, the sort). **Standing rule: prefer to fail loudly over
returning fewer points.**

### The row-group index moved off the file

`selectMortonRowGroups` picks row groups from the footer statistics the probe already
read. The bisect it replaces range-read ~2 MB **per step** to recover two numbers,
`log2(rowGroups)` steps per interval, for a few hundred intervals — which is how one
viewport query could pull most of a 439 MB file to answer a question the footer had
already answered. One 1024 µm tile of the 12.1M-point element, both returning the same
643,961 points:

| row-group selection | range reads | bytes | wall |
|---|---|---|---|
| bisect | 97 | 175.12 MB | 2911 ms |
| footer index | **32** | **57.83 MB** | **1035 ms** |

The remaining 32 reads *are* the row-group data. It is also stricter than the bisect,
which tested only `max` and assumed the groups tile the code space without gaps. The
bisect stays as the fallback for an artifact whose statistics will not parse, and this
retires `loadParquetRowGroupColumnExtent`'s standing TODO.

### The grid comes from the artifact

The first cut of `mortonTiledStrategy` pinned `minZoom: -1, maxZoom: -1` with
`tileSize: 512`, which in deck's non-geospatial traversal makes **every tile 1024
element-local units at every zoom** — a fixed 11 × 4 = 44-tile grid for the life of the
layer. Zooming in never got more detail, nothing budgeted the cache (deck's default
`maxCacheSize` of `5 × selected` could retain ~220 tiles / ~71M rows against a 4M
resident cap), and 1024 fell out of `tileSize` and `z`, not out of the data.

`pointsTileGrid.ts` derives both ends from point density:

- **finest** — a tile stays at least as big as one row group's footprint,
  `sqrt(maxRowsPerGroup / density)`. Reads round up to whole row groups, so below that
  four tiles fetch what one used to. Same argument as `MORTON_ZCOVER_MAX_DEPTH`.
- **coarsest** — at most `POINTS_TILE_TARGET_ROWS` (400k) per tile.
- `zoomOffset = log2(modelMatrixScale)` couples `z` to the viewport, which deck picks
  from a zoom in **world** units while tile spans are in **local** units. Lands a tile at
  256–512 screen pixels.

For this element: `minZoom -1 … maxZoom 0` (1024 µm / ~324k rows and 512 µm / ~81k rows),
`zoomOffset 2.234`. Two levels, worth stating rather than hiding: **the row-group size is
the floor** — 50k-row groups put it at ~402 µm. The old fixed 1024 was accidentally near
-optimal *for this file* and would not be for one an order of magnitude smaller or denser.

`maxCacheSize` is now `cacheRowBudget / estimatedRowsPerTile`, clamped to [16, 512],
against `DEFAULT_POINTS_MEMORY_CAP` — 16 tiles here, ~5.2M rows worst case. `maxRequests`
stays 6, as a decision rather than an inheritance.

### Bytes per viewport query

Measured 2026-09-23 on the regenerated store, driving the real `loadPointsInBounds` and
counting **true bytes on the wire** through a logging proxy (`Cache-Control: no-store`, so
no cache could hide a fetch). Scenario is the manifest's `center-tile` — the interquartile
box, 25% of the slide's area. Node was the driver deliberately:
`supportsParquetStreaming()` is false there, so the run takes the byte-oriented row-group
path this document is about.

**The writer's encoding change converts fully into bandwidth.** `transcripts_morton` went
439.0 → 234.3 MB on disk, and the same ratio shows up per query:

| `transcripts_morton`, one viewport | old | new | |
|---|---|---|---|
| all 541 features | 168.0 MB | **89.6 MB** | 1.87x |
| one gene | 165.8 MB | **88.2 MB** | 1.88x |

Not an artifact of file size: this path range-reads whole row groups, so a smaller row
group is directly a smaller read, and the two ratios agree to two decimal places. Decode
also went 22 → 12 ms on a 200k-row frame.

**Feature selection still buys effectively zero I/O:**

| selection | points returned | range reads | bytes |
|---|---|---|---|
| all 541 features | 3,128,885 | 96 | 89.6 MB |
| one gene | **129** | 92 | 88.2 MB |
| 16 genes | 107,247 | 92 | 88.2 MB |

A 24,000x reduction in points for **1.5%** of the bytes, off the same reads — row groups
are chosen *spatially* and a gene is spread across all of them, so no feature filter can
skip one. What the filter buys is far fewer points leaving the worker (GPU, memory,
overdraw), not less I/O. (Counted as distinct byte ranges; the 96/92 difference is footer
and probe reads, not the filter skipping anything.) Narrowing the *fetch* by feature needs
a feature-primary index — the open index-selection question in ADR 0002/0003, and what the
permutation elements exist to explore. `morton_then_feature` is byte-for-byte identical to
`transcripts_morton` on every scenario — Morton is 16 bits per axis, so at 12.17M points
only ~0.14% of rows share a code and the secondary key is almost never consulted.
`feature_then_morton` is rejected by the probe and falls back to the capped preload
(274.8 MB in 6 requests), as designed.

**What is still expensive:** ~92 of 245 row groups for 25% of the area. A rectangle maps
to many Morton intervals, so spatial selectivity falls far short of the area ratio, and
that is now the dominant term — the encoding change halved the constant without touching
it. Narrowing it needs fewer round trips (batching adjacent row groups, or concurrency —
the scan loop awaits each serially) or a genuinely feature-selective artifact. Note
**smaller row groups make the current loop worse**: cost tracks row-group *count*, so a
`row_group_size=5000` permutation turned one viewport query into ~2,400 serial round
trips. That is why the coarsened-Morton / small-row-group sweep was written and dropped.

**Method note, because it bit twice.** The proxy log *appends*, so two runs under the same
scenario labels sum silently and read as a regression — the first pass of this measurement
reported the new store using *more* (179.1 MB, 196 requests), which was an aborted run
added to a good one. The tell is distinct ranges versus request count: 96 ranges against
196 requests means each was fetched twice. Start a fresh log per run and assert no
scenario label repeats.

## Still open

- **The no-LOD gap.** Zooming *out* is the one direction viewport tiling does not help:
  every tile is full resolution, so at the default zoomed-out framing the tiled path
  selects all 44 tiles and loads **12,165,029 points / ~158 MB** — the whole artifact,
  against the preload's 4M-row prefix. That is ~3x the rows for a picture that is correct
  rather than a Z-curve prefix, streamed in 44 pieces instead of one blocking decode. The
  fix is a multi-resolution points pyramid (the writer already has a `points multiscale`
  command), not a finer index, and it is the strongest argument for doing that next.
  `pointsTiling: 'off'` is one config key away if the trade is wrong for a deployment.
- **Tile cache eviction.** Answered at the *accounting* level by the row-budgeted
  `maxCacheSize` above, and open deliberately per [ADR 0005](../adr/0005-memory-accounting-before-management.md):
  nothing evicts by bytes, and a tile's real footprint is whatever its points weigh, so a
  dense viewport can still exceed the estimate. Manage after accounting.
- **Preload *and* tiles?** A small resident window for instant zoomed-out context is
  attractive but re-introduces two batches with different code spaces, reviving the
  alignment invariants D5 escaped. Default: no.
- **Multi-layer worker contention (D6).** Two tiled layers multiply concurrent row-group
  reads through one parquet worker. Out of scope here; D5 makes it reachable.
- **Does `matching` apply on the tiled path at all?** The feature-index scan exists
  because a resident window truncates the dataset; viewport tiling answers the same
  problem differently. Likely not planned for tiled elements — confirm rather than leave
  both running.
- **A cheaper bounds check.** `parquetFooterStats.ts` could read the x/y extent directly
  for no extra I/O once a float stat decoder exists (`decodeIntStat` handles integers
  only). It tests the *convention* (box == exact min/max) rather than the invariant, so it
  belongs alongside the sampling check, not instead of it.

## Verification

- **Fixture:** a `transcripts_morton` element (Morton sort + `feature_name_codes` +
  **enough row groups that a viewport touches a strict subset** — a single-row-group
  fixture proves nothing), written by
  `python/spatialdata-js-util/.../index_permutations.py`.
- The current store is `xenium_2.q0.001.htj2k.index-permutations-v3.zarr`
  (2026-09-23: new encodings, page index, `sorting_columns` declared only where the file
  honours it); the 2026-08-12 store remains alongside as the old-encoding baseline. On an
  **older copy** than that, `transcripts_morton_then_feature` and
  `transcripts_feature_then_morton` carry the stale sentinel box — the probe now refuses
  them loudly instead of drawing half the slide.
- **`transcripts_feature_then_morton` is not a tiling fixture** and never was: it is
  feature-primary, so the probe declines it by design. Use it for the feature-code
  row-group index on the *preload* path. The tiling fixtures are `transcripts_morton` and
  `transcripts_morton_then_feature`.
- **The debug overlay is the instrument** — `showTileDebugOverlay` colours tiles by
  status; pair it with `read_network_requests` to confirm reads are bounded by the
  viewport.
- **Verify on both surfaces:** the full-UI `SpatialCanvas` and `SpatialCanvasViewer` own
  separate handlers, with real data.
- **Beware the fixture-proxy trap:** the vis demo's `/test-fixtures` proxy 502s when a
  launcher sets `PORT`, and worktrees need the fixture symlink.
