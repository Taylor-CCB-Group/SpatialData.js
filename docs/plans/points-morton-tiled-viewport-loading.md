# Points: Morton-tiled viewport-driven loading (D5)

Status: **steps 1–5 implemented** (2026-08-12); the default flip (step 7) is **blocked on
step 6**, the tile grid — see [The tile grid, measured](#the-tile-grid-measured).
Implements [points-redesign-punchlist](./points-redesign-punchlist.md) **D5** and the
"Morton is still dark" line in [points-mvp-and-roadmap](./points-mvp-and-roadmap.md).
Format contract: [ADR 0002](../adr/0002-spatially-aware-vector-loading.md).
Encoding → strategy mapping: [ADR 0003](../adr/0003-points-render-resource.md).
Structural substrate: [ADR 0004](../adr/0004-resource-resolver-owned-by-core.md) /
[layer-data-engine-decomposition](./layer-data-engine-decomposition.md).
Per-element path table: [points-preload-feature-filter-status](./points-preload-feature-filter-status.md).

Harvest source: branch `claude/quizzical-roentgen-3ee079`, preserved as tag
**`backup/points-wip-20260702`** (tip `a724230`). Key commits `42dbf21` (points tiling),
`42c3ece` (WIP tiling + visualization integration), `3517646` (points render resource).

---

## The point

A Morton-sorted points artifact lets us read **only the row groups whose Morton
interval intersects the viewport**, so a 12M-row transcripts element renders without
ever holding 12M rows in memory. Today we hold the first *N* rows (memory cap) in a
resident preload and draw those, whatever the viewport is. That is the wrong axis:
zooming into a corner should get *more* detail there, not the same truncated prefix.

This plan lights up the `morton-tiled` encoding end to end. It is **not** a rewrite —
almost everything below already exists and is tested; what was lost in the harvest is
the *wiring*, and the wiring's home moved from a React hook to a resolver.

---

## Why it is dark today

Three facts, in order of how directly they block:

1. **The renderer adapter hardcodes the path off.**
   [`PointsRendererAdapter.ts:80`](../../packages/layers/src/adapters/PointsRendererAdapter.ts:80)
   is `const RESOLVE_OPTIONS = { experimentalOptimizations: 'off' as const }`, and every
   resolve site passes `metadataKnown: false`
   ([:118](../../packages/layers/src/adapters/PointsRendererAdapter.ts:118),
   [:252](../../packages/layers/src/adapters/PointsRendererAdapter.ts:252),
   [:272](../../packages/layers/src/adapters/PointsRendererAdapter.ts:272)).
   `resolvePointsEncoding` ([`pointsLoader.ts:65`](../../packages/core/src/pointsLoader.ts:65))
   therefore cannot return anything but `'preloaded-columnar'`.
2. **Nothing probes the metadata.** `getPointsTilingMetadata`
   ([`VPointsSource.ts:2256`](../../packages/core/src/models/VPointsSource.ts:2256),
   surfaced on the element at [`models/index.ts:693`](../../packages/core/src/models/index.ts:693))
   has no caller outside tests. `PointsResolver` has slots for `preload`, `rowCodes`,
   `catalog` and `matching` — and none for tiling metadata. The probe lived in the
   deleted god-hook and did not come across with the decomposition.
3. **So `mortonTiledStrategy` is unreachable.** The adapter says so itself at
   [`PointsRendererAdapter.ts:263`](../../packages/layers/src/adapters/PointsRendererAdapter.ts:263):
   *"No path reaches this today… It is wrong the moment a tiled strategy is pointed at
   a growing resource, which is what D5 does."*

## What already exists (do not rebuild)

| Layer | Piece | Where |
|---|---|---|
| core | Morton interval computation, sentinel handling, metadata type | [`pointsTiling.ts`](../../packages/core/src/pointsTiling.ts) |
| core | Row-group bisect + range reads + in-bounds scan (worker & main-thread) | [`VPointsSource.ts:2488`](../../packages/core/src/models/VPointsSource.ts:2488) `loadMortonPointsInBounds` |
| core | Metadata probe, cached per element path | [`VPointsSource.ts:2256`](../../packages/core/src/models/VPointsSource.ts:2256) |
| core | `morton-tiled` loader factory | `createMortonTiledPointsLoader`, [`pointsLoader.ts`](../../packages/core/src/pointsLoader.ts) |
| core | Worker tile scan + protocol | [`pointsWorkerScan.ts`](../../packages/core/src/workers/pointsWorkerScan.ts), `points-worker.ts` |
| layers | `TileLayer` strategy w/ abort, clipping, per-tile scatter, debug overlay | [`mortonTiledStrategy.ts`](../../packages/layers/src/mortonTiledStrategy.ts) |
| layers | Encoding → strategy table | [`pointsRenderStrategies.ts`](../../packages/layers/src/pointsRenderStrategies.ts) |
| layers | Tile debug store + hooks + polygon data | `pointsTileDebug.ts`, `pointsTiledDebugHooks.ts` |
| layers | Probe-vs-preload decision helpers | `planPointsLoads`, `shouldPreloadAfterMetadataProbe`, [`pointsLoadPlan.ts`](../../packages/layers/src/pointsLoadPlan.ts) |
| layers | Blocked-preload user messages | `pointsPreloadBlockedMessage`, `pointsTilingUnavailableMessage` |
| tests | `mortonPointsTiling.spec.ts`, `pointsMortonScanFilter.spec.ts`, `pointsTiling.spec.ts`, `pointsTileDebug.spec.ts`, `pointsLoadPlan.spec.ts`, `pointsRenderStrategies.spec.ts` | core/layers |

## What to harvest from the WIP branch

The branch is the only place this ran end to end. Its wiring is **hook-shaped** — a
`Map` on `loadedDataRef` plus an `await` inside a giant `Promise.all` — and must be
re-expressed as resolver slots. Harvest the *logic and its edge cases*, not the shape.

| From `backup/points-wip-20260702` | Verdict | Notes |
|---|---|---|
| `useLayerData.ts:958–1010` — plan gate (`wantsOptimized`, `metadataKnown`, `planPointsLoads`) | **Port** | Becomes the `tiling` branch of `PointsResolver.plan()`. The helper it calls already exists on main. |
| `useLayerData.ts:1191–1237` — the probe, its `renderableMetadata` gate (`supportsRowGroupRangeReads && bounds`), preload-cache eviction on success, and *both* fallback paths (probe says "not tileable" → preload; probe throws → preload) | **Ported (step 1)** | These branches are the whole reason the path degrades safely. The "probe failed ⇒ still try preload" arm is kept, as a `failed`-but-reads-as-`null` slot. Its `getParquetRowCount` fallback was **not** ported: `probedTotalRows` fed `shouldPreloadAfterMetadataProbe`, which ignores `totalRows` entirely — the read was vestigial. |
| `useLayerData.ts:1576` — `hasRenderableLayerData` counting `tilingMetadata.bounds` as renderable | **Port** | On main this is `pointsEngine.hasData` ([`useLayerData.ts:931`](../../packages/vis/src/SpatialCanvas/useLayerData.ts:931)); a tiled element has no resident data and would read as "nothing to draw". |
| `useLayerData.ts:1621–1640` — world bounds from `tilingMetadata.bounds` when there is no preload | **Port** | Main's points branch ([`useLayerData.ts:990`](../../packages/vis/src/SpatialCanvas/useLayerData.ts:990)) returns `null` without preloaded data → no framing, dead "Center on layer". |
| `pointsTileProgress.ts` (whole file) | **Take nearly as-is** | Already imports `TileDebugStore`/`TiledPointsDebugState` from `@spatialdata/layers`, which main still exports. Gives `Loading points… (3/12 tiles, 1,204,993 points)`. |
| `PointsStylePanel.tsx` | **Do not take** | Superseded by main's `PointsLayerPanel` + `PointsFeatureFilterPanel`. Lift only the tile-debug toggle if we want one. |
| `renderers/pointsRenderer.ts` tiled branch | **Do not take** | Dead on main (deleted in `dd290db`); the composite + strategies replaced it. |
| `resolvePointsRenderResource.ts` (vis copy) | **Do not take** | Already relocated to `layers` (`f704a58`). |

## Target design

### 1. A `tiling` slot on `PointsResolver`

Add a fifth `RequestSlot` next to `preload`/`rowCodes`/`catalog`/`matching`
([`PointsResolver.ts:94`](../../packages/core/src/engine/PointsResolver.ts:94)):

```ts
tiling: RequestSlot<'probe', PointsTilingMetadata | null>;
```

- Key `'probe'` — the element path is fixed, so there is exactly one request. `null` is
  a **settled fact** ("this element is not tileable"), not an absence, exactly like the
  catalog's `null` for a `feature_key`-less element.
- `plan()` emits `{ id: \`${key}#tiling\`, resource: 'tiling' }` when
  `wantsOptimized && !tilingSettled(key)`.
- The **preload task becomes conditional on the probe's answer**, via the existing
  `planPointsLoads({ wantsOptimized, metadataKnown, tiledMetadata, hasPreloaded })`. Until
  the probe settles, plan neither — that is the whole point of probing first, and it is
  why `planPointsLoads` returns two independent booleans.
- A failed probe settles `null` **and is retryable**, so `retry()` re-runs it; the
  fallback preload still runs (WIP branch's catch arm).

`wantsOptimized` needs a home in `PointsResolveConfig`
([`PointsResolver.ts:88`](../../packages/core/src/engine/PointsResolver.ts:88)) — a
serialisable `pointsTiling?: 'auto' | 'off'` entry prop (default decided in step 4;
see open question 1).

### 2. `blockingResources` must stop being a constant

`readonly blockingResources = ['preload']`
([`PointsResolver.ts:178`](../../packages/core/src/engine/PointsResolver.ts:178)) and
`isBlocking` treats `status === 'idle'` as blocking
([`SpatialEntryStore.ts:157`](../../packages/core/src/engine/SpatialEntryStore.ts:157)).
A tiled entry never plans a preload, so its `preload` slot stays `idle` **forever** and
the canvas sits on "Loading layer data…" with auto-fit never firing.

This is load-bearing and easy to get wrong: **auto-fit piggybacks on the
`isBlocking` true→false transition** — the same trap that bit the shapes
non-blocking pass. Two candidate fixes:

- **(a)** `blockingResources` becomes a method of the entry's state — `['tiling']` until
  the probe settles, then `['preload']` or `[]`. ADR 0004 already calls it *"data, not a
  switch"* ([`resolver.ts:128`](../../packages/core/src/engine/resolver.ts:128)), and this
  is the first case that needs it to vary.
- **(b)** Keep the array and have the tiled path settle `preload` to a sentinel
  "not applicable" resolution.

**Recommend (a).** (b) puts a lie in the preload slot and will confuse every later
reader of the resident-batch invariants.

### 3. Adapter: a real tiled resource, identity-stable

`PointsRendererAdapter` gains a `getTiledResource(element, key, metadata)` memo keyed on
`(element, metadata)`, resolving with `{ tilingMetadata, metadataKnown: true }` and
`experimentalOptimizations: 'auto'`. Identity stability is not cosmetic here: a fresh
resource per `project()` tears down the `TileLayer` and **re-fetches every visible
tile**. The existing memo (`resolve()`, keyed on batch identity + signature) is the
model; `pointsRenderResourceSignature` already includes `parquetPath` and the `rg` flag.

Delete `RESOLVE_OPTIONS` as a module constant and thread the option through from config.

### 4. Bounds, framing and status

- Resolver `EntryResources.bounds` for a tiled entry comes from
  `tilingMetadata.bounds` (transformed), not from a resident batch.
- `pointsEngine.hasData` / `hasRenderableLayerData` must count "tileable metadata
  settled" as renderable.
- Tile progress: mount `pointsTileProgress.ts` in vis, feed `isLoading` and the footer
  message from `pointsTileLoadingMessage(...)`. `isBlocking` stays false once metadata is
  known — tiles refine an already-framed layer, they do not gate first paint.

### 5. Feature filter, colour, and the code column — the real gap

The tiled path filters by feature (`loadPointsInBounds({ featureCodes })` → row-group
scan), and `mortonTiledStrategy` already threads `featureCodes` into `getTileData` and
into its `updateTriggers`. But:

- **`loadMortonPointsInBounds` returns geometry only** — `data` is `[xs, ys(, zs)]` and
  the per-point feature code is *used for filtering and then discarded*
  ([`VPointsSource.ts:2488`](../../packages/core/src/models/VPointsSource.ts:2488); the
  worker path returns `workerResult.data` and the main path builds from
  `Float32PointBuffer`s only). So a tiled batch has **no `featureCodes`**, and
  colour-by-feature, the palette LUT and Feature Highlight — all of which key on the
  per-point code — silently degrade to flat colour.
- **`mortonTiledStrategy` does not forward the colour props** it would need even if the
  codes were there: its `scatterStyleProps` carries only `color`, sizes, opacity,
  `modelMatrix`, `use3d`, whereas `preloadedScatterStrategy` forwards `colorByFeature`,
  `featureCodeSpaceSize`, `featureColorOverrides` and `highlightFeatureCode`.
- **`rowCodes` is preload-shaped.** `plan()`'s `needsRowCodes` gate reads the first
  `min(rowCount, cap)` rows *in file order* to align with the resident batch. On a tiled
  element there is no resident batch and that read is both meaningless and expensive —
  the gate must exclude the tiled path. Per-tile codes ride the tile batch instead.
- **The catalog's preview phase disappears.** The resident-subset preview falls out of
  the preload decode; with no preload, only the full scan can produce a catalog. For a
  Morton artifact with `{feature_key}_codes` that is the cheap row-group dictionary-page
  scan, so this is acceptable — but the catalog task must be planned explicitly rather
  than arriving as a side effect of a decode that no longer happens.
- **`renderCap`** is a whole-batch notion; on the tiled path it has to be per tile (or
  retired in favour of the tile budget). Decide, don't inherit silently.

Steps 3–4 below own this; step 2 ships **flat-coloured** tiles on purpose.

---

## Implementation sequence

Each step builds, passes tests, and leaves the branch shippable.

**Step 1 — Probe (no render change). ✅ done.**
`tiling` slot + `plan()` gate + `PointsResolveConfig.pointsTiling` (default `'off'`, so
planning is byte-for-byte today's when nobody opts in). `planPointsLoads` moved to
`core` — `core` cannot import from `layers` and duplicating the decision is how the two
drift — with a re-export left behind. 13 headless specs in
`core/tests/pointsResolver.spec.ts`.

One thing the design above got wrong, found by the tests: gating only on `isTiled` is
not enough. **Row codes and the matching scan have to wait on the *pending* probe too.**
Planning them while it is in flight does the wasted read *and settles the codes*, so the
next pass reads "already loaded" and the waste becomes invisible — the exact shape of
bug this deferral exists to prevent. `plan()` returns early on `probeMetadata || isTiled`.

*Acceptance met: no behaviour change with tiling off; full suite (854 tests), build and
biome green.*

**Step 2 — Draw tiles (flat colour).**
Adapter `getTiledResource`; `blockingResources` becomes state-derived; bounds and
`hasData` from metadata; `pointsTileProgress` wired to the footer. Tiled elements render
through `mortonTiledStrategy` with flat colour and no feature filter.
*Acceptance: a Morton fixture frames correctly on load, pans/zooms with tiles loading in,
"Center on layer" works, no "Loading layer data…" hang, non-Morton elements unchanged.*

**Step 3 — Per-point codes on tile batches. ✅ done.**
`scanMortonTableInBounds` takes an optional codes buffer and appends in lockstep with
the geometry; the worker handler builds one and returns it (the protocol's
`PointsWorkerColumnarResult.featureCodes` and its transferable already existed, so the
boundary needed nothing). `loadMortonPointsInBounds` projects the code column whenever
the artifact HAS one rather than only when filtering — the no-filter "all features"
view was exactly the case arriving without codes — and both its worker and
main-thread returns carry them. `mortonTiledStrategy` forwards the colour props, and
vis stops forcing `colorByFeature: false`.

Short codes are dropped rather than padded, on both paths: a partial array would leave
the tail reading code 0 — a *valid* feature — and mis-colour it with conviction.

*Acceptance met: on a real 12.1M-point element a tiled layer draws per-feature colours
matching the preloaded path; tests pin one code per point, every code a real catalog
entry, and codes still returned (and all equal to the selection) under a filter.*

**Step 4 — Feature filter + catalog on the tiled path. ✅ done.**
The selection reaches `getTileData` (and its `updateTriggers`, so a change refetches
rather than serving the previous selection's tiles) and is applied inside the
row-group scan. The composite's filter machinery is untouched: it is gated on
`preloaded-columnar`, so a tiled layer passes straight through. `renderCap` stays
unset — it is a resident-window notion, and a tile is already bounded by its viewport.

The catalog is now **planned** for a tiled entry. On the preloaded path it arrives
free as a preview off the geometry decode; a tiled entry never decodes a resident
batch, so nothing built one — and the selection is stored as feature NAMES, which
cannot become codes without it. A saved config with a selection would otherwise draw
every feature until someone opened the panel. A failed catalog is not re-planned
(`retry()` is the way back), or the task re-emits forever.

The feature-row panel also needed a tiled case. Every other signal it reads describes
a resident batch a tiled layer does not have, so its rows fell through to "beyond the
resident window; select it to fetch its points" — greyed, and wrong twice: the points
are available, and no feature-index scan is involved.

**The original acceptance criterion here was wrong, and the measurement is worth
keeping.** "Fewer row-group range reads" does not happen on a Morton artifact:

| viewport query on a 12.1M-point element | points returned | row groups | bytes |
|---|---|---|---|
| all 541 features | 3,128,988 | 92 | 158.1 MB |
| one gene (EPCAM) | 87,594 | 92 | 158.1 MB |

Row groups are chosen **spatially**, and a gene's points are spread across all of
them, so no feature filter can skip one. What the filter buys is 36x fewer points
leaving the worker — the GPU, memory and overdraw win — not less I/O. Narrowing the
*fetch* by feature needs a feature-primary index; that is exactly what the
`transcripts_feature_then_morton` / `transcripts_morton_then_feature` permutations
exist to explore, and it is the open index-selection question in ADR 0002/0003 rather
than something this step could deliver.

*Acceptance met, restated: filtering a tiled element narrows what each tile returns
(36x for one gene), a selection change refetches rather than reusing cached tiles, and
a tiled element resolves a name-based selection without the panel ever opening.*

---

## The tile grid, measured

Steps 1–4 made the path *work*; they never examined what deck is actually asked to
tile. Measured against the live `xenium_2.q0.001.htj2k.index-permutations` store
(2026-08-12), reading `TileLayer.state.tileset` directly in the browser.

### It is one fixed grid of ~44 tiles that never subdivides

[`mortonTiledStrategy.ts:97`](../../packages/layers/src/mortonTiledStrategy.ts:97) pins
`minZoom: -1, maxZoom: -1` with `tileSize: 512`. deck's non-geospatial traversal
([`tileset-2d/utils.js` `getIdentityTileIndices`](../../node_modules/.pnpm/@deck.gl+geo-layers@9.3.7_@deck.gl+core@9.3.7_@deck.gl+extensions@9.3.7_@deck.gl+core@9_95b707e63fcfb29d74e361206c081c66/node_modules/@deck.gl/geo-layers/dist/tileset-2d/utils.js))
computes `scale = 2^z * 512 / tileSize`, so **every tile is 1024 element-local units,
at every zoom**. For `transcripts_morton` (bounds 10871 x 3627 µm) that is an
11 x 4 = **44-tile grid, fixed for the life of the layer**:

```
extent   [3.42, 2.45, 10874.72, 3629.29]
selected 44 tiles (x 0..10, y 0..3), cacheSize 44, all loaded, scheduler idle
```

Consequences, all still open:

- **Zooming in never gets more detail.** The same 1024-unit tile is re-used at every
  scale; a 50 µm viewport still reads a 1024 µm tile. This is the axis the whole plan
  exists to fix, and it is only half-fixed: loading follows the viewport's *position*
  but not its *scale*.
- **Zooming out reads everything.** 44 tiles, 6 at a time
  (`maxRequests` default 6), each a row-group range read. Nothing budgets this.
- **1024 units is arbitrary.** It falls out of `tileSize: 512` and `z = -1`, not out of
  the Morton structure. The natural tile is a Morton cell — `zcoverRectangle` already
  speaks that language — so the grid and the index currently disagree about what a
  region is.

### Where the "regions that never get queued" come from

Not scheduling, and not our loader. The tile grid is clipped to
`resource.loader.capabilities.bounds` — the **sentinel bounding box**, read from the
first row group by `extractSentinelBoundingBox`
([`pointsTiling.ts:231`](../../packages/core/src/pointsTiling.ts:231)) — and on two of
the four elements in the permutations store that box is wrong:

| element | sentinel bbox (= `TileLayer.extent`) | true x/y extent | tiles that can exist |
|---|---|---|---|
| `transcripts_morton` | x 3.42–10874.72, y 2.45–3629.29 | same | 11 x 4 = 44 |
| `transcripts_morton_then_feature` | x 3.42–**10550.23**, y **2144.59–3138.84** | x 3.42–10874.72, y 2.45–3629.29 | 11 x 2 = **22** |
| `transcripts_feature_then_morton` | identical to the above | as above | — |

*(Fixed by the regeneration in step 5 — all four now report the true extent, and
`transcripts_morton_then_feature` selects the full 11 x 4 grid. Kept here because it is
the worked example of how a bad box presents.)*

The observed symptom is exactly that: on `transcripts_morton_then_feature` the tileset
only ever holds y = 2 and y = 3, so the top half of the tissue is never *requested* —
no pending tile, no debug rectangle, nothing to wait for. Switch the same view to
`transcripts_morton` and all 44 tiles select and load.

**The store is at fault, not the reader.** Reproducing the stored `morton_code_2d`
from x/y confirms which box the codes were quantised against — 320 sampled rows per
element, x-first interleave:

| element | matches under sentinel bbox | matches under true extent |
|---|---|---|
| `transcripts_morton` | 0 / 320 | **320 / 320** |
| `transcripts_morton_then_feature` | 0 / 320 | **309 / 320** (rest are float-boundary ties) |

So the codes in the `*_feature` permutations were quantised against the full extent
while their sentinel rows record a sub-box: the two disagree *inside the same file*.
Today's writer does not reproduce this — running `morton_sort_points` over all three
sort orders yields the true bbox every time, because `_extreme_positions` is taken
before the sort and the sentinels are prepended after
([`points.py:43`](../../python/spatialdata-js-util/src/spatialdata_js_util/points.py:43)).
**The fixture on disk is stale and needs regenerating.**

That also means the damage is wider than the tile grid: `metadata.bounds` is the
Morton quantisation domain for `mortonIntervalsForBounds`
([`pointsTiling.ts:208`](../../packages/core/src/pointsTiling.ts:208)), so a wrong box
also maps every viewport to the wrong Morton intervals and therefore the wrong row
groups. Points are never *misplaced* — `loadMortonPointsInBounds` re-filters the
decoded rows to the requested bounds — so the failure is silently subtractive, the same
shape as the bisect bug fixed in `6cfe7bb`.

### The reader gap this exposes — now guarded

We trusted the sentinel box completely, on a claim the artifact makes about itself, and
a wrong claim degraded into "some of the map is missing" with no error anywhere.

The probe now **recomputes `morton_code_2d` from x/y** for a sample of real rows and
refuses to tile unless a majority agree
([`pointsTiling.ts` `mortonBoundsAgreeWithCodes`](../../packages/core/src/pointsTiling.ts),
called from `VPointsSource.mortonBoundsMatchStoredCodes`). That tests the invariant that
actually matters — *is this box the quantisation domain?* — rather than a convention, so
an artifact with a deliberately padded domain still tiles. A rejected element drops its
`bounds` and reports `supportsRowGroupRangeReads: false`, which is the same pair the
"oversized sentinel row group" case already produces, so the resolver's existing probe
gate falls straight through to the capped preload. It also `console.warn`s: a silent
downgrade is what got us here.

Cost, measured on the 12.1M-point / 245-row-group element:

| probe | wall | range reads | bytes |
|---|---|---|---|
| before | 414 ms | 3 | 0.37 MB |
| with the guard | 523 ms | 4 | 2.16 MB |

One extra row-group read, once per element, cached with the metadata — about one step of
the bisect that a single viewport query already runs eight of. The sample is taken from
the **middle** of the file: a truncated box can agree with the true one near the origin
by coincidence, never in the interior. Only positive evidence of disagreement disables
tiling; an unreadable sample keeps today's behaviour rather than losing the feature to an
unrelated failure.

A cheaper check may become possible: `parquetFooterStats.ts` now parses per-row-group
column statistics out of the footer (that is what the feature-code index uses), so the
x/y extent could be read directly once a float stat decoder exists — `decodeIntStat` only
handles integer physical types today. That would compare the box against the data's real
extent for no extra I/O, but it tests the *convention* (box == exact min/max) rather than
the invariant, so it belongs alongside this check, not instead of it.

### The second claim we were taking on trust: the sort

A `morton_code_2d` column does not make a file Morton-**sorted**. A feature-primary
artifact — `transcripts_feature_then_morton`, sorted `(feature, morton)` — carries the
identical column with identical, correct values, a correct sentinel box, and every field
the probe looks for. Only the order is wrong, and nothing in the file says so. The
row-group bisect binary-searches that index assuming it ascends, so on this element it
lands somewhere arbitrary and a tile comes back holding whichever feature blocks happened
to live in the row groups it picked. That is what "some tiles just pick up one or other
feature, most miss" was.

Read from footer statistics, the two indexes could not look more different — each row
group of the feature-primary file spans nearly the whole code range, because one gene is
scattered across the whole slide:

| element | descents (`min[i] < max[i-1]`) | first six row groups `[min, max]` |
|---|---|---|
| `transcripts_morton` | **0** / 244 | `[0,0] [437752573,724881652] [724881909,732597813] …` |
| `transcripts_morton_then_feature` | **0** / 244 | identical — morton is still the primary key |
| `transcripts_feature_then_morton` | **185** / 244 | `[0,0] [450484663,4193473654] [443527237,4288997289] …` |

Note the second row: a *secondary* feature key is harmless, which is why this has to be
measured rather than inferred from the element's name. The index-manifest does record
`tiling_kind: "experimental"` for the feature-primary condition, but a store's manifest is
not something a reader can rely on; the file itself now answers the question.

The probe checks it, and the check is **free** — `datasetMetadata.parts` already carries
the footer bytes by the time it runs, and `morton_code_2d` is INT32 with complete
statistics on all 245 row groups. Failing it skips the sentinel sampling read as well,
since the outcome can no longer change, so a rejected element costs *less* than before.
One subtlety: the column is `uint32` and Morton codes use the top bit for real, so the
statistics must be decoded unsigned — `decodeIntStat` would read the far corner of the
slide as negative.

**This also retires the bisect's standing TODO.** `loadParquetRowGroupColumnExtent` says
it "should be reading the row group's column statistics" and instead range-reads and
decodes each row group twice to recover a few boundary values. Those statistics are right
here, complete, and free. Folding them in belongs with step 6.

Under-selection has now bitten this path four times (`zcover` depth, the row-group bisect,
the sentinel box, the sort). Standing rule for the tiled path: prefer to fail loudly over
returning fewer points.

---

## Remaining work

**Step 5 — Trustworthy grid. ✅ done.**
The permutations store was regenerated in place (2026-08-12): all four elements now
report the true extent, and their codes reproduce 320/320 from it. Today's writer never
had the bug — `_extreme_positions` is taken before the sort and the sentinels prepended
after — so the file was simply older than the writer. The reader-side guard above landed
with it, so the next stale artifact degrades to preload with a warning instead of
silently drawing part of the map.

**Step 6 — A grid that follows zoom.**
Replace the fixed `minZoom/maxZoom: -1` with a real zoom range, sized so a tile is a
Morton cell rather than an arbitrary 1024 units, and decide the tile budget
(`maxRequests`, `maxCacheSize`) rather than inheriting deck's defaults. Open question 3
(tile-cache accounting) has to be answered here, not after. Fold the row-group bisect
onto footer statistics while in here: they turn out to be complete and free for
`morton_code_2d` (see above), which is what
[`loadParquetRowGroupColumnExtent`](../../packages/core/src/models/VTableSource.ts) has
wanted since it was written, and a subdividing grid issues many more bisects than the
current one does.

**Step 7 — Defaults + docs.**
Flip `pointsTiling` default (open question 1), update
[points-preload-feature-filter-status](./points-preload-feature-filter-status.md)'s
per-element table, close D5 in the punch-list, changeset.

---

## Verification

- **Fixture.** A `transcripts_morton` element (Morton sort + `feature_name_codes` +
  multiple row groups) written by `spatialdata-js-util` — see
  `python/spatialdata-js-util/src/spatialdata_js_util/index_permutations.py` and
  `scripts/benchmark_points_index.py`. Needs to be small enough to live under the demo's
  `/test-fixtures` but with **enough row groups that a viewport touches a strict subset**
  — a single-row-group fixture proves nothing.
- **Beware the fixture-proxy trap**: the vis demo's `/test-fixtures` proxy 502s when a
  launcher sets `PORT`, and worktrees need the fixture symlink.
- The permutations store was regenerated on 2026-08-12; all four points elements are
  now sound. If you are on an **older copy**, `transcripts_morton_then_feature` and
  `transcripts_feature_then_morton` carry the stale sentinel box — the probe will now
  refuse to tile them and say so in the console, rather than drawing half the slide.
- **`transcripts_feature_then_morton` is not a tiling fixture** and never was: it is
  feature-primary, so the probe declines it by design. Use it to exercise the
  feature-code row-group index on the *preload* path, which is a different mechanism
  and unaffected. `transcripts_morton` and `transcripts_morton_then_feature` are the
  tiling fixtures.
- **The debug overlay is the instrument.** `showTileDebugOverlay` already colours tiles by
  status; use it plus `read_network_requests` to confirm range reads are bounded by the
  viewport rather than fetching the whole file.
- **Verify on both surfaces** — the full-UI `SpatialCanvas` and `SpatialCanvasViewer` own
  separate handlers; a tiled layer must work in both, with real data.

## Open questions

1. **Default for `pointsTiling`.** `'auto'` costs one metadata probe (a footer read) on
   every points element before anything renders; `'off'` means nobody gets the feature
   without opting in. Leaning `'auto'`, with the probe made cheap and its failure
   arm falling straight through to preload — but measure the probe on a real Xenium
   store first. **Not yet.** The default cannot flip while the grid never subdivides
   (steps 5–6): today `'auto'` would trade a truncated-but-predictable preload for a
   viewport-following layer that still cannot resolve past 1024 units, and that reads
   as a regression when you zoom in. The probe cost is not what is holding it up.
2. **Preload *and* tiles?** A tiled element could still preload a small resident window
   for instant zoomed-out context while tiles fill in. Attractive, but it re-introduces
   two batches with different code spaces and revives the alignment invariants D5 was
   supposed to escape. Default: no.
3. **Tile cache eviction / memory accounting.** deck's `TileLayer` has its own cache; the
   memory cap is expressed in *rows of a resident batch* and does not describe it. Needs a
   position before this is enabled by default — see
   [ADR 0005](../adr/0005-memory-accounting-before-management.md) (account first, manage
   after): the tile cache is a second pool that accounting currently cannot see.
4. **Multi-layer worker contention (D6).** Two tiled layers multiply concurrent row-group
   reads through one points worker. Out of scope here, but D5 makes it reachable.
5. **Does the resident/matched machinery apply at all on the tiled path?** The
   feature-index scan (`matching`) exists because the resident window truncates the
   dataset. Viewport tiling is a different answer to the same problem. Likely: `matching`
   is not planned for tiled elements — confirm rather than leave both running.
