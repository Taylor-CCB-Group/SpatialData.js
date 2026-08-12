# Points: Morton-tiled viewport-driven loading (D5)

Status: **step 1 implemented** (2026-08-12); steps 2–5 design.
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

**Step 3 — Per-point codes on tile batches.**
Emit the feature-code column from both scan paths (`scanMortonTableInBounds` gains a
codes buffer; `scanMortonRowGroupsInBoundsInWorker` transfers it alongside the geometry),
carry it onto `ColumnarNdarrayPointsBatch.featureCodes`, and forward the colour props
through `mortonTiledStrategy`'s `scatterStyleProps`.
*Acceptance: colour-by-feature, palette overrides and Feature Highlight look identical on
tiled and preloaded elements.*

**Step 4 — Feature filter + catalog on the tiled path.**
Plan the catalog explicitly for tiled elements (dictionary-page scan); exclude tiled
elements from the `rowCodes` gate; confirm selection changes re-key `getTileData` and
that a selection is applied *inside* the row-group scan (it already is — verify it is not
double-applied in the composite). Decide `renderCap` semantics.
*Acceptance: filtering a tiled element narrows what is fetched, not just what is drawn —
observable as fewer row-group range reads.*

**Step 5 — Defaults + docs.**
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
   store first.
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
