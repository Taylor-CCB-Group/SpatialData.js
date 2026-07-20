# Shapes: non-blocking + viewport-tiled loading

Status: **Phase 0–1 implemented** (2026-07-17); Phase 2 (tiled artifact) still design.
Supersedes the shapes items in
[`resource-resolver-handoff.md` §Track B](./resource-resolver-handoff.md) with a
concrete, researched design. Implements the shapes half of
[ADR 0002](../adr/0002-spatially-aware-vector-loading.md) ("Shapes format 0.3
remains on the current parquet path; large-shape spatial tiling still needs a
separate GeoParquet artifact/writer slice").

## Status — what shipped (Phase 0–1)

The **non-blocking** goal is done; the design landed somewhere better than the original
"binary `PolygonLayer`" sketch below (see Phase 1 notes for the evolution):

- **Off-thread, non-blocking geometry.** The geometry worker decodes WKB → flat buffers
  **and tessellates** the render topology (`core/shapesPolygonTessellate`), transferring
  both back zero-copy. `ShapesResolver.blockingResources = []`; shapes never gate first
  paint. A main-thread tessellation fallback covers the no-worker path.
- **`FlatPolygonLayer`** (`@spatialdata/layers`) — a hand-rolled, **vertex-pulling** luma
  layer: an attribute-less draw where the vertex shader reconstructs each vertex's
  position + boundary edge-distance from two shared geometry textures via `gl_VertexID`,
  and imputes an anti-aliased outline with `fwidth` in the fragment (no separate outline
  layer). Memory ≈ the stock indexed fill; renders arbitrary polygons at ~2.7M scale.
- **Feature state as a per-feature colour texture** (the reusable "table column → buffer"
  primitive): colour-by-column / hide / fade re-upload only a small texture, never the
  geometry. Picking is computed in-shader from the feature index.
- **Outline** is a lightened derivation of the fill, width-capped to a fraction of each
  shape's on-screen size and faded out for sub-pixel shapes (clear zoomed in, no
  domination/moiré zoomed out).

Open follow-ups: emit texture-ready (padded) buffers from the worker to shrink the
main-thread GPU-upload block; a WGSL variant (WebGPU storage buffers replace the
texture-packing and likely absorb the upload cost); explicit per-feature stroke override
on the polygon path; non-blocking associated-table load; Phase 2 tiling; renaming the
points worker to a general parquet worker (coordinate with the points worktree).

## Goal

Two things, and they are **separable** — the plan ships them in that order:

1. **Non-blocking.** Shapes must stop gating first paint. Today
   `ShapesResolver.blockingResources = ['geometry']` and geometry means a
   **full-element WKB decode on the main thread**, behind the modal
   `"Loading layer data..."` overlay. Points never do this — they load *inside*
   their composite layer.
2. **A spatial query that actually reduces I/O + decode.** Not a post-load cull:
   fetch and decode only the parquet row groups whose geometry overlaps the
   viewport.

The second requires a spatial-index artifact; the first does not. Non-blocking is
a *consequence* of moving the load into the layer, not a feature bolted on.

## What's true today (the starting line)

- `ShapesResolver` blocks on `geometry`; `element.loadRenderData()` →
  `VShapesSource.loadShapesRenderData()` does a **whole-element** WKB parquet
  decode on the **main thread** (`ol/format/WKB`). `VShapesSource` has **zero**
  worker usage; `VPointsSource` imports the whole worker client.
- The batch type is pathological: `ShapePolygon = Array<Array<[number,number]>>`
  — one JS array object per vertex. Not transferable, not cheap. This is *why*
  shapes never went to the worker.
- `VShapesSource.loadShapesInBounds` **exists and lies**: ignores `bounds`,
  `zoom`, `columns`; does a full load; stamps `loadMode: 'full-filter'`. Zero
  callers, zero tests. **Delete or honestly fix it first.**
- Rendering is one-shot: `buildShapesPrebuiltData` materialises the entire
  feature array and hands it to a plain `PolygonLayer` / `ScatterplotLayer` as one
  `data` prop. No `TileLayer`, no `getTileData`, no `AbortSignal`.
- **But shapes already inherit the whole range-read stack** from `VTableSource`
  (`loadParquetDatasetMetadata`, `readParquetRowGroupBytesByGroupIndex`,
  `canLoadParquetRowGroups`, multipart handling, `ParquetRowGroupBytesChunk`).
  The tiling plumbing points uses is *already available* to shapes.

## The points template to mirror (verified file anchors)

| Concern | Points file | Shapes analog to build |
|---|---|---|
| Core loader seam (deck-free) | `core/src/pointsLoader.ts` (`CorePointsLoader`, `capabilities`, `loadInBounds`, batch union) | `core/src/shapesLoader.ts` |
| Self-loading composite | `layers/src/PointsLayer.ts` | `layers/src/ShapesLayer.ts` |
| The actual TileLayer | `layers/src/mortonTiledStrategy.ts` (`getTileData` → `loadInBounds({bounds, signal})`, abort handling) | `layers/src/geoparquetTiledStrategy.ts` |
| Strategy dispatch on `capabilities.kind` | `layers/src/pointsRenderStrategies.ts` | shapes strategy table |
| Resource + `experimentalOptimizations` | `layers/src/resolvePointsRenderResource.ts` | `resolveShapesRenderResource.ts` |
| Worker decode + transferables | `core/src/workers/points-worker.ts`, `pointsWorkerClient.ts` (`decodeGeometryWithFeaturesInWorker`), `pointsWorkerProtocol.ts` | add a `decode-shapes-wkb` request + handler + client, or a `shapes-worker.ts` |
| Row-group range reads (INHERITED — reuse as-is) | `core/src/models/VTableSource.ts` | — |
| Tiling metadata + real bounds loader | `core/src/pointsTiling.ts`, `VPointsSource.loadPointsInBounds` (morton bisect) | `ShapesTilingMetadata`, `VShapesSource.loadShapesInBounds` (bbox bisect) |
| Python spatial writer | `python/spatialdata-experimental-writer/src/.../points.py` (morton sort, sentinels, row groups) | shapes GeoParquet writer under `shapes.experimental/<key>/` |

Note: the live vis points path currently sets `experimentalOptimizations: 'off'`
(`PointsRendererAdapter.ts`), so even the points `TileLayer` is test-exercised but
**not yet the app default**. Mirroring the architecture is not enough to *see*
tiling — the switch has to be flipped too. Budget for that.

## Research findings that shape the design

### Finding 1 — GeoArrow is transferable; that part of your optimism holds

GeoArrow polygon/point columns are flat Arrow buffers (a single interleaved or
separated coordinate buffer + int32 ring/geometry offset buffers) — **zero
per-vertex JS objects**, so they `postMessage` across the worker boundary as
`ArrayBuffer`s. This is exactly the batch property the handoff doc requires and
the current `Array<Array<[number,number]>>` batch lacks.
[GeoArrow format](https://geoarrow.org/format.html)

So **"GeoArrow with the existing WKB store"** resolves cleanly: GeoArrow is not a
second store, it is the **in-memory target layout**. Two load paths converge on
it:

- **wild-type WKB parquet** → worker decodes WKB → GeoArrow buffers (decode
  unavoidable, but off-main-thread and into a transferable layout).
- **tiled artifact** → GeoArrow-encoded (or WKB) GeoParquet, spatially pruned →
  buffers arrive ready (no WKB decode on the GeoArrow-encoded variant).

Same `ShapesBatch` either way; ADR 0003's strategy registry dispatches on
`loader.capabilities.kind`.

### Finding 2 — the feature-state gap is the real risk, and it's NOT where you expected

You were optimistic that "carrying the requisite data isn't the problem." The data
*carries* fine. What `@geoarrow/deck.gl-geoarrow`'s `GeoArrowPolygonLayer` does
**not** cleanly support is **dynamic per-feature hide / fade / filter** — which is
core to this app (feature-state, picking-driven highlight; see
`shape-picking-requirements`, the MDV integration).

- Per-feature **color** from an Arrow column: **yes**. **Picking** to a row index:
  **yes** (`GeoArrowPickingInfo.index`/`.object`). `updateTriggers`: **yes**.
- Per-feature **filter/hide**: **no first-class path.** Passing an Arrow column to
  `getFilterValue` silently fails to render
  ([issue #169](https://github.com/geoarrow/deck.gl-layers/issues/169), open);
  the function-accessor route is reported slow. The only working fallback is to
  rebuild the fill-color alpha attribute via `updateTriggers.getFillColor` — a
  **full-attribute recompute over all features** per change, not a cheap
  `DataFilterExtension` uniform toggle.
- Also: open bug [#214](https://github.com/geoarrow/deck.gl-layers/issues) —
  Arrow-IPC padded offset buffers break polygon **strokes**.

Version risk is **low**, contrary to the deck/luma/viv coordination worry: the
package (renamed `@geoarrow/deck.gl-layers` → `@geoarrow/deck.gl-geoarrow@0.4.1`)
declares a `^9.0.0` peer range on `@deck.gl/*` and **no `@luma.gl/*` peer at all**.

**Consequence — the recommended split:** use **GeoArrow as the data plane** (the
transferable worker-decode target and the tiled-artifact encoding), but keep our
**own binary deck layer** for rendering, feeding it GeoArrow's flat
`positions`/`polygonIndices` buffers. We already hand-roll custom deck attributes
+ shader injection for points colour-by-feature
(`deck-layer-extension-attribute-gotchas`), so retaining a binary `PolygonLayer`
we control — rather than adopting `GeoArrowPolygonLayer` wholesale — keeps
feature-state fast and picking exactly as specified. The handoff doc already
sanctions this: *"hand-rolled flat arrays are a sanctioned outcome if
[deck.gl-geoarrow] cannot [carry feature-state]."* Research says it cannot.

> **DECIDED (2026-07-16): GeoArrow data plane + our own binary layer.** We render
> through a binary `PolygonLayer`/`ScatterplotLayer` we control, fed GeoArrow's
> flat buffers — not `GeoArrowPolygonLayer` wholesale. Everything else in the plan
> is invariant to this call.

### Finding 3 — viewport row-group pruning on GeoParquet is confirmed feasible

A browser range-reader **can** prune row groups by viewport using GeoParquet
1.1's `covering.bbox` column, **if** the file is spatially sorted at write time.

- The `covering.bbox` metadata points at a Parquet **struct column**
  (`bbox.{xmin,ymin,xmax,ymax}`), whose four leaves each carry per-row-group
  min/max **statistics**. Overlap test per row group (no geometry decode):
  `rg.max(xmin) ≥ qxmin ∧ rg.min(xmax) ≤ qxmax ∧ rg.max(ymin) ≥ qymin ∧ rg.min(ymax) ≤ qymax`.
  [GeoParquet 1.1](https://geoparquet.org/releases/v1.1.0/)
- **Spatial sort is mandatory for selectivity** — unsorted, every row group's bbox
  spans the dataset and nothing prunes. This is the direct analog of the morton
  sort the points writer already does.
- **Write recipe (single durable artifact, read by geopandas AND browser):**
  DuckDB `spatial`, `ORDER BY ST_Hilbert(geom, <dataset extent>)`, zstd,
  `ROW_GROUP_SIZE ≈ 100k`. DuckDB auto-emits the 1.1 bbox covering column. Pass
  the dataset extent to `ST_Hilbert` or ordering degrades.
  [DuckDB + GeoParquet Hilbert](https://cloudnativegeo.org/blog/2025/01/using-duckdbs-hilbert-function-with-geoparquet/)
- **Reader:** the repo already uses parquet-wasm (selective `rowGroups: [...]`
  reads) and the `VTableSource` range-read stack. Footer statistics give the
  min/max; hyparquet is a pure-JS fallback for stats if parquet-wasm's binding
  doesn't surface per-row-group column stats (flagged to verify).
- **FlatGeobuf** (packed Hilbert R-tree, feature-level) prunes finer but is
  row-oriented and a *second* artifact — rejected against the "one columnar
  artifact geopandas + browser both read" requirement. Recorded as the fallback
  if row-group granularity proves too coarse.

## Plan

### Phase 0 — honesty + seam (no artifact, no worker)

1. **Delete `VShapesSource.loadShapesInBounds`** (the lying stub) or reduce it to
   an honest full-load that reports its mode truthfully.
2. **Define the loader seam** `core/src/shapesLoader.ts`, cloning `pointsLoader.ts`:
   `ShapesLoaderCapabilities { kind, batchFormat, bounds?, supportsViewportTiles }`,
   `ShapesBatch` (GeoArrow-buffer variant + today's decoded variant during
   migration), `ShapesLoadInBoundsOptions { bounds, signal }`,
   `CoreShapesLoader { capabilities, loadInBounds, loadAll? }`. Kinds:
   `'wkb-full' | 'geoparquet-tiled'` (+ reserved geoarrow variants).
3. Ship **one loader**: `wkb-full`, `supportsViewportTiles: false`,
   `loadInBounds` ignores bounds and returns the full batch honestly.

> **Phase 1 status: DONE (2026-07-16), verified live on Visium HD `square_016um`.**
> Non-blocking; WKB decode off the main thread in the points worker → transferable
> flat buffers; binary `SolidPolygonLayer` fill render with index-driven
> feature-state + picking; auto-fit decoupled from blocking. Event loop stays
> responsive through decode (the single remaining main-thread stall is deck's
> polygon **tessellation** — inherent, and what Phase 2 tiling ultimately bounds by
> loading only the viewport). Validated at scale on Visium HD `square_002um` (~2.7M
> polygons): loads without OOM, non-blocking.
>
> **Interaction buffer-thrash fixed (2026-07-17).** Diagnosis found deck rebuilding
> the entire per-feature fill-colour attribute on *every* re-render — 2.7M
> `getFillColor` calls, a ~600ms main-thread stall on every hover/pan. Root cause: a
> fresh `[100,100,200,180]` default-colour array per render (a default parameter +
> `??` fallbacks) fed `updateTriggers.getFillColor`, which deck compares shallowly,
> so it read as "colours changed". Fix: a stable `DEFAULT_SHAPE_FILL_COLOR` module
> constant + a colour `updateTrigger` memoised on the (stable) feature-state runtime.
> Verified: hover 670ms→66ms, zoom→5ms, `getFillColor` calls on hover 2.7M→0.
> Regression test in `shapesLayer.spec.ts`. A residual ~150ms blip on drag-*end*
> remains — likely the picking-buffer rebuild on the pan/zoom `pickable` toggle
> (`spatialcanvas-pan-zoom-picking-cost`), a separate, smaller matter.
>
> **Fill-colour "one column behind" fixed (2026-07-17).** Exposed by the thrash fix
> (deck now only rebuilds when the trigger truly changes): `getStableShapeFeatureStateRuntime`
> keyed its runtime cache on a *column-based* signature string, but a column switch
> serves the previous column's rows until the new ones load — so the runtime was
> built from stale rows and never invalidated when the real rows arrived (same
> signature). Fix: key the runtime cache on the fill-colour entry's **identity**
> (it's a fresh object when the rows change), not just its signature. Regression
> test `shapesProjection.spec.ts`; verified live cycling `array_col` → `array_row`
> → `in_tissue` (each shows the latest column).
>
> **Follow-ups surfaced:** (a) **binary stroke / distinct outlines** — `PolygonLayer`'s
> stroke sublayer (`_getPaths`) iterates data as objects and cannot consume a binary
> buffer, so the binary path is fill-only; fill-coloured outlines read poorly as
> shapes, so add distinct outlines via a binary `PathLayer` over the same ring
> buffers. (b) **Non-blocking associated-table load** — the fill/tooltip table still
> blocks for seconds on large elements: `_loadParquetTableUncached` (`VTableSource`)
> runs the WASM `readParquet` + `tableFromIPC` decode on the main thread. The fix is
> the shapes-geometry pattern applied to whole-table decode: a `decodeParquetTable`
> worker request + route the base loader through it (main-thread fallback retained).
> **Held as follow-up, not done in this pass (2026-07-17), because it shares two
> surfaces with the active points worktree:** (1) `_loadParquetTableUncached` is a
> `SpatialDataTableSource` base method `VPointsSource` extends and calls, so the change
> ripples into the points load path; (2) it extends the **worker protocol**, which the
> points pass is concurrently reshaping (adding abort/cancellation between row-group
> chunks). No textual conflict on today's trees (points touches only `VPointsSource.ts`),
> but reshaping the shared protocol in parallel is high-friction. This *is* the
> "points worker → general parquet worker" generalization already deferred below —
> sequence it after both passes land, together with that rename. (c) **Filling colour buffers
> off-thread** — even the *legitimate* colour rebuild (on a real feature-state
> change) is an O(vertices) main-thread pass; a worker-built binary colour attribute
> would remove it. (d) **tooltip ping-pong**, still deferred (pick/tooltip identity).

### Phase 1 — non-blocking + off-thread decode

> **Scope decision (2026-07-16, revised):** the worker **is** in this pass — the
> non-blocking flip alone achieves little because the WKB decode still janks the
> main thread. What is deferred is only the **rename** of `points-worker.ts` to a
> general *parquet worker*: shapes reuse the existing points worker (making it more
> general-purpose), and if that generality holds we rename it later, coordinated
> with the points worktree, rather than churning shared files twice. The
> self-loading composite and the tiled artifact remain Phase 2 (tiling).

4. **Flip blocking** — DONE. `ShapesResolver.blockingResources = []`; shapes
   dropped from `useLayerData`'s `isBlocking`. Modal overlay gone; non-modal
   `isLoading` spinner covers the wait; `getLayers` skips a shapes layer until its
   geometry is ready.
5. **Off-thread decode → transferable flat buffers.** Add a shapes-geometry decode
   request to the **existing** points worker (additive: new union member + handler
   case + client fn, to keep the merge surface small). The worker reads the shapes
   parquet bytes, decodes the WKB geometry column into **flat GeoArrow-style typed
   arrays** (positions + polygon `startIndices`; circles are already columnar), and
   transfers them back zero-copy. Main-thread fallback = today's
   `_decodeWkbColumnNested`/`Flat`. `ShapesRenderData`/`ShapesBatch` gains a
   flat-buffer polygon representation.
6. **Binary polygon render.** Feed deck's `PolygonLayer` in **binary mode**
   (`data: { length, startIndices, attributes }`) from the flat buffers — the layer
   we already own, no `GeoArrowPolygonLayer`. Map picking `index → featureId` and
   drive feature-state (fill/stroke/hide/fade) by index. Circles stay on the
   existing columnar `ScatterplotLayer` path.

**Deferred:** the tooltip ping-pong (step below — reaches the pick/tooltip identity
model, not just a cache); the `ShapesLayer` self-loading composite and tiled
artifact (Phase 2); renaming the worker (future).

**Follow-ups this pass surfaced:**

- **Auto-fit was coupled to shapes-blocking (fix in this pass).** The one-shot
  auto-fit in `SpatialCanvasViewer` (and the fullscreen refit in `index.tsx`) gates
  on `!isBlocking` and fits to `getWorldBoundsForVisibleLayers()`. It relied on the
  `isBlocking` `true→false` transition to fire *exactly* when shapes bounds became
  ready. With shapes non-blocking, a **shapes-only** view fires the fit before
  bounds exist and never re-fits → opens un-framed until "Center on layer".
  Image/points/labels views are unaffected (they still block and provide bounds
  first). Fix = decouple "wait for world bounds" from "block first paint", race-safe
  against the enable→loading window. Verified live on Visium HD `square_016um`.
- **Tooltip ping-pong (deferred):** reaches the pick/tooltip identity model, not just
  the resolver cache — `getTooltipMetadata(key)` is called by element only at 4
  sites, 3 in pick/tooltip handlers where two layers sharing an element with
  different `tooltipFields` are inherently ambiguous. Deferred rather than
  half-fixed.

### Phase 2 — the tiled artifact + tiled loader

8. **Python writer** under `python/spatialdata-experimental-writer/`, a
   `shapes` subcommand cloning `points.py` but: DuckDB Hilbert sort on geometry,
   GeoParquet 1.1 bbox covering column, zstd, sized row groups. Target
   `shapes.experimental/<key>/` (ADR 0002 — standard readers can't consume a
   re-sorted GeoParquet as canonical). **Open sub-decision:** GeoArrow-native
   encoding (zero browser WKB decode) vs WKB (max geopandas interop) — verify the
   geopandas round-trip and parquet-wasm→arrow zero-copy layout before committing.
9. **`ShapesTilingMetadata`** + a real **`VShapesSource.loadShapesInBounds`** that
   reads footer bbox stats, bisects/prunes row groups, range-reads survivors
   (reusing `readParquetRowGroupBytesByGroupIndex`), decodes in the worker to
   GeoArrow buffers.
10. **`geoparquetTiledStrategy`** (clone `mortonTiledStrategy.ts`): deck `TileLayer`,
    `getTileData` → `loader.loadInBounds({ bounds, signal })`, abort on tile
    teardown, per-tile binary `PolygonLayer`.
11. **`resolveShapesRenderResource` + `experimentalOptimizations`** wiring (clone
    `resolvePointsRenderResource.ts`); `geoparquet-tiled` selected when the
    artifact's tiling metadata is present, else `wkb-full`. **Flip the switch on
    in the live adapter** (points is still `'off'`).

## Sub-decisions to resolve in-flight (not blocking to start)

- Artifact geometry encoding: GeoArrow-native vs WKB (Phase 2 step 8).
- Worker: extend `points-worker.ts` vs a dedicated `shapes-worker.ts`.
- Row-group granularity: if 100k-row groups prune too coarsely for dense small
  polygons, revisit FlatGeobuf as the tiling-only artifact.

## Unverified flags carried from research

- parquet-wasm surfacing per-row-group column min/max on its metadata binding
  (else source stats from hyparquet).
- `GeoArrowPolygonLayer` MultiPolygon-with-holes correctness (layout supports it;
  no explicit test found) — moot if we render with our own binary layer.
- DuckDB version actually emitting GeoParquet 1.1 `covering` metadata.
