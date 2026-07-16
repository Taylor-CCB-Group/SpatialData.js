# Step 1 consumption — tactical plan for `useLayerData`

**Status:** IMPLEMENTED — all three increments landed on
`claude/resource-resolver-adr-88a5c8`. `useLayerData.ts` net −724/+394 lines; the
17-member surface and `useLayerData.spec.tsx` guard stayed green throughout
(full suite 549 passing, vis typecheck + build clean). See "Session note".
**Decisions:** [ADR 0004](../adr/0004-resource-resolver-owned-by-core.md) §1, §4, §6;
[resource-resolver-handoff.md](resource-resolver-handoff.md) Step 1.
**Scope:** make `packages/vis/src/SpatialCanvas/useLayerData.ts` *consume* the
resolvers #85 landed unconsumed. The 17-member public surface does not change; MDV
sees no difference. Guard net: `packages/vis/tests/useLayerData.spec.tsx`.

Grounded in a full read of the 1,873-line hook and all four resolvers. Read the ADR
for *why*; this is *how*.

---

## Core insight

`PointsDataEngine` is already a facade over `PointsResolver` (core) +
`PointsRendererAdapter` (layers), so **points already consume their resolver** via
the `pointsEngine` member. Remaining work: shapes, images, labels.

**Step 1 sources DATA from the resolvers' data getters — NOT from
`SpatialEntryStore.snapshot()`.** Snapshots/`bounds`/`notices` are for the eventual
`project()` adapter (Step 3). Consuming data getters (as `pointsEngine` already
does) is the minimal behavior-preserving move and avoids two regressions (below).
The store's `reconcile` loop is introduced only in the final increment; earlier
increments drive each resolver's `plan()`/`load()` directly from an effect.

Resolver data getters available today:
- `ShapesResolver`: `getRenderData(key)`, `getTooltipMetadata(key)`, `getFillColorRows(key)`
- `ImagesResolver`: `getLoadedData(key)` -> `ImageChannelDefaults` (mirrors `ImageLoaderData`)
- `LabelsResolver`: `getLoadedData(key)` -> `LabelsChannelDefaults`, `getTooltipMetadata(key)`
- `PointsResolver`: via the `pointsEngine` facade (unchanged)

`imageLoaderChannelDefaults.ts` was already extracted verbatim from the hook's
image/labels branches and is shared by the raster resolvers -> images/labels are
behavior-identical re-housings.

---

## Two couplings that make this NOT mechanical

1. **Tooltip -> geometry patch.** The old shapes load merges tooltip metadata into
   geometry: when `tooltipRowIndices` is present it overwrites
   `renderData.rowIndexByFeatureIndex` (useLayerData.ts:775-788). The resolver keeps
   `geometry` and `tooltip` independent, so `getRenderData` is RAW geometry.
   Re-apply the patch in a vis-side memo (`getMergedShapeRenderData`), memoised on
   `(raw identity, tooltipRowIndices identity)` — a fresh merged object per
   `getLayers()` call would be a deck teardown per frame.

2. **Physical-size bounds.** `getWorldBoundsForLayer` for images/labels passes
   `getPhysicalSizeScalingMatrixFromMeta(source)` into `boundsFromImagePixelExtents`
   (useLayerData.ts:1263,1282). The raster resolvers' `rasterBounds` omits it. So
   KEEP the hook's bounds compute (sourcing the loader/geometry from the resolver);
   do NOT switch bounds to `snapshot().bounds`. Points bounds already stay in the
   hook (PointsResolver returns `bounds: null`).

---

## Increment order (each ends green: `pnpm -r --filter='!docs' test`)

### Increment 1 — shapes (guard-tested path)

Construct near `pointsEngine` (~useLayerData.ts:571-586):
- `shapesResolver = useMemo(() => new ShapesResolver({ spatialData, callbacks:{ onStatus:(id,res,st)=> (res==='geometry'||res==='tooltip') && setLayerResourceStatus(id,res,st) } }), [spatialData, setLayerResourceStatus])`  (rebuild on dataset swap; dispose old in cleanup; fillColor never drove load-state).
- subscribe effect: `shapesResolver.subscribe(notifyLoadedDataChanged)`; cleanup unsub + `dispose()`.
- driving effect (deps `[layers, layerOrder, shapesResolver]`): loop visible shapes layers, build `ResolveContext<ShapesResolveConfig, ShapesElement>` {entryId=layerId, elementKey=elem.key, kind:'shapes', element, config:{tooltipFields, fillColorByColumn}, transform=elem.transform}; `for (task of shapesResolver.plan(ctx)) void shapesResolver.load(task, ctx, neverAbortSignal)`.

Projection memos (kept in vis; extend `shapePrebuiltData`/`shapeFillColorData` entry
types with a `source?` identity field):
- `getMergedShapeRenderData(key)` — raw + tooltipRowIndices patch (coupling #1).
- `getShapePrebuilt(layerId, renderData, hiddenIds)` — `buildShapesPrebuiltData`, invalidate on (hiddenIds signature, renderData identity).
- `getShapeFillColorEntry(layerId, key, config, renderData)` — `buildShapeFillColorByFeatureId` from `getFillColorRows`; invalidate on (fillColor signature, rows identity, renderData identity); delete when no fill column.

Read-site rewrites (original line numbers):
- 633-850 shapes load decision + async branch -> delete (driving effect replaces).
- 596-612 sync prebuilt-invalidation pass -> delete (prebuilt now lazy).
- 1144-1150 reloadElement shapes -> `shapesResolver.evict(key)`; still clear per-layer prebuilt/fillColor + worldBounds.
- 1184 hasRenderableLayerData -> `shapesResolver.getRenderData(elem.key) !== undefined`.
- 1220-1238 getWorldBoundsForLayer shapes -> source renderData from `getMergedShapeRenderData`; KEEP compute.
- 1324-1349 getLayers shapes -> renderData=merged; prebuilt=`getShapePrebuilt`; featureStateRuntime from `getStableShapeFeatureStateRuntime(..., getShapeFillColorEntry(...))`.
- 1611-1639 getFeatureTooltip -> tooltip fields/columns/signature from `getTooltipMetadata`; renderData from merged.
- 1660-1672 getShapePickEvent -> prebuilt from memo; row-index inputs from `getTooltipMetadata` + merged renderData.

Cleanup: remove `LoadedData.shapes`, `LoadedShapesData`, `loadShapesLayerData`, old
`loadShapeFillColorData`, unused imports `loadShapesTooltipMetadata`, `loadShapesData`.

Watch: renderData/prebuilt identity stability across repeated `getLayers()` (identity
test asserts it for points; shapes must hold the same).

### Increment 2 — images + labels

`ImagesResolver`/`LabelsResolver` from `./resolvers/RasterResolvers`, constructed
`{ fetchMultiscales: getOmeZarrMultiscalesData, spatialData, onStatus:(id,_r,st)=>setLayerResourceStatus(id,'image',st) }`.
Same plan/load loop. Reads: `getImageLayerLoadedData`/`getImageLoadedDataByElementKey`/
`getLabelsLayerLoadedData` -> `getLoadedData(key)`; `getVivLayerProps` merges same
channel fields; labels tooltip -> `getTooltipMetadata`. KEEP the hook's physical-size
bounds compute (coupling #2). Delete old image/labels load branches, `LoadedData.images/labels`.

### Increment 3 — fold points + introduce `SpatialEntryStore`

Replace the three per-kind driving effects with one `SpatialEntryStore({points,shapes,images,labels})`
+ single `store.reconcile(contexts)` commit-effect; points resolver =
`pointsEngine.resourceResolver`. Keep the `pointsEngine` member (panels use it).
Remove `toLoad` remnants. The render-phase `void pointsEngine.ensureMatchingFeaturesLoaded/
ensureRowFeatureCodes` in getLayers (1375,1425) is Track A / the `plan()` migration —
OUT OF SCOPE here.

---

## Constraints (do not break)
- Referential stability of getter members: `SpatialCanvasViewer` uses
  `layerData.getVivLayerProps/.isBlocking/.getWorldBoundsForVisibleLayers` as
  useMemo/useEffect deps (SpatialCanvasViewer.tsx:263-313). Keep them useCallback'd.
- 17-member surface exact (useLayerData.spec.tsx asserts the key set).
- spatialData lifecycle: resolvers close over spatialData; rebuild + dispose on change.
- DoD boundaries: core no react/deck/viv; layers no react.

## Session note
The plan was *designed* in an earlier session whose Edit/Write harness tools did not
persist changes under `docs/` or `packages/` (new files at the WORKTREE ROOT
persisted; edits and new files in subdirs reported success but never hit disk — mtime
unchanged, `git status` clean; Bash OS-level writes worked everywhere). That doc was
written via Bash as the workaround.

**Resolved.** A later session verified write access with a one-line probe to
`packages/vis/src/SpatialCanvas/useLayerData.ts` (confirmed on disk via `head` /
`git status` / `stat`, then reverted) and executed all three increments directly with
the Edit tool. The worktree write issue is gone.

## Implementation notes (post-execution)
- **Inc 1 (shapes):** `ShapesResolver` via `useMemo`, disposed on rebuild; vis-side
  projection memos `getMergedShapeRenderData` (coupling #1) / `getShapePrebuilt` /
  `getShapeFillColorEntry`. Caught a regression: the fill-colour entry must not be
  created until rows load, or the feature-state runtime (memoised on the entry's
  presence in its signature) never rebuilds and fill colours never appear.
- **Inc 2 (images + labels):** `ImagesResolver`/`LabelsResolver`; `LabelsLoaderData`
  retyped to the resolver's `LabelsChannelDefaults` (tooltip is now a separate
  resource). Physical-size bounds compute (coupling #2) kept in the hook. Labels
  tooltip status is no longer forwarded to `layerLoadStates` — nothing gates on it.
- **Inc 3 (store):** one `SpatialEntryStore` + one `reconcile()` effect replaces the
  per-kind driving effects (hook now has two `useEffect`s total). Points is wrapped in
  a **non-owning proxy** (`createNonOwningResolver`, no-op `dispose`) so the stable
  `PointsDataEngine` the panels subscribe to survives a store rebuild on dataset swap.
  Points row-codes / feature-index scan stay on the render-phase engine calls in
  `getLayers` (Track A), so the points reconcile config carries only the memory cap.

**Follow-up:** the guard test covers the shapes + points lifecycle, resource identity
and the surface — but NOT shape fill-by-column, image/labels rendering, or tooltips.
Those paths (including the Inc 1 fill-colour regression) were verified by reading, not
by a failing test. Add coverage there before Track A builds on this.
