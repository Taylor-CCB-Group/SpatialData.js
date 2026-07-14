# Resource Resolver — implementation handoff

**Status:** ready for implementation
**Decisions:** [ADR 0004 — Resource Resolver Owned By Core](../adr/0004-resource-resolver-owned-by-core.md), [ADR 0005 — Memory Accounting Before Management](../adr/0005-memory-accounting-before-management.md)
**Supersedes:** [layer-data-engine-decomposition.md](layer-data-engine-decomposition.md)
**Vocabulary:** [CONTEXT.md](../../CONTEXT.md) — *Resource Resolver, Renderer Adapter, Spatial Entry, Resolution, Spatial Entry Error, Entry Notice, Encoded/Decoded Tier, Resource Ceiling*

Read the two ADRs first. This document is sequencing, not rationale.

---

## The shape

```text
core     Resource Resolver    reconcile · cache · supersede · stream · evict · bounds
                              per-kind: Points / Shapes / Images / Labels
                              Resolution<T> · SpatialEntryError · EntryNotice
                              RenderStack (moved from layers)
   │
   ├──► layers   deck Renderer Adapter   project() → renderInput · render() → Layer[]
   │      │                              PointsLayer · shapesLayer · LabelsLayer
   │      └──► vis   React binding (useSyncExternalStore) · panels · Viv passthrough
   │
   ├──► tgpu-htj2k   three.js/TSL Renderer Adapter   (separate repo, already live)
   │
   └──► headless     no renderer
```

**Phase separation** — this is the load-bearing part:

| Phase | Owner | Purity | When | May start I/O? |
|---|---|---|---|---|
| `plan(ctx)` | **Resolver** | pure, sync | commit only | no — *returns* task descriptors |
| `load(task, ctx)` | **Resolver** | async | commit only | **yes — the only place** |
| `project(entry, config)` | **Renderer Adapter** | pure, sync | end of reconcile | no |
| `render(projected, opts)` | **Renderer Adapter** | pure, sync | **during React render** | no — *is handed no engine handle* |

> **Correction (2026-07-14).** An earlier revision of this table was headed
> *"phase separation inside a resolver"*, implying all four phases live on the
> resolver. They do not. ADR 0004 §4 puts `project()` and `render()` on the
> **Renderer Adapter** in `layers`: *"identity-stable memoisation is a **deck
> requirement** … so it belongs on the renderer side."* This document is
> sequencing, not rationale — where they disagree, **the ADR wins**. The
> consequence is concrete: `PointsDataEngine`'s lazy render-resource memos move
> to `layers`, not to `core`.

`render()` receives a frozen resolved state and nothing that can start work. That
makes today's `void engine.ensureMatchingFeaturesLoaded(...)` inside `getLayers()`
**a type error**, not a code-review note. The `queueMicrotask(() => this.notify())`
defence in `PointsDataEngine` disappears with it.

---

## Sequence

### Step 0 — shared contracts (land first, land alone)

`packages/core/src/engine/{resolution,errors}.ts`. The types, plus the two small
functions that are inseparable from them. No imports beyond `core`'s own.

- `Resolution<T>` — `idle | loading{partial?, stale?, progress?} | ready{value} | failed{error, stale?}`
- `SpatialEntryError` — discriminated union; every case carries `message` +
  `retryable`, plus its own structured payload
- `EntryNotice` — the non-fatal channel
- `toSpatialEntryError(cause, ctx)` — the single classifier; the *one* place a
  throw becomes a value

Also here: `fromResult()`, a three-liner lifting `getTransformation`'s existing
`Result<T, CoordinateSystemNotFoundError>` into a `Resolution`. This is why
`Resolution` lives in `core` — the `Result` it lifts is already there.

> **Do not** put `Resolution` in `zarrextra`. Do not push it down into `core`'s leaf
> loaders — they keep throwing, and the resolver classifies at the seam.

### Step 1 — the resolver interface + four thin adapters (shared; the fork point)

Extract the interface **from the shape `PointsDataEngine` already has**, generalised.
Write `Shapes` / `Images` / `Labels` resolvers as **thin adapters holding today's
Maps and calling today's functions**. Behaviour-identical. No load changes, no
race fixes, no memory work.

> **Correction (2026-07-14) — placement is per-kind, not "all four in `core`".**
> ADR 0004 §6 has been amended. `core` defines the **interface**;
> `PointsResolver` and `ShapesResolver` live in `core` (every type they touch is
> already a `core` type). `ImagesResolver` and `LabelsResolver` implement the same
> interface but live in **`vis`**, because `createImageLoader` already takes an
> injected `fetchMultiscales` — there is no React closure to break and **no image
> port to invent** — and because `avivatorish` is a de-vendoring holding pen for
> code that also lives upstream in Viv and MDV, with an image-state model its own
> README calls *"still evolving"*. `zarrextra`'s `VivCompatiblePixelSource`
> already serves both Viv and `tgpu-htj2k`, so the images seam already exists
> *below* the resolver: images is the one kind where the duplication argument does
> not apply. **Add no image port to `core`.** See ADR 0004 §"Amendment — the image
> port".

`useLayerData` becomes a loop over resolvers instead of a switch over kinds. Keep
its 17-member public surface intact behind a compat shim — MDV consumes it.

**This is the commit that unblocks parallel work.** After it lands, the tracks below
touch different files.

Move in the same step (mechanical, no behaviour change):
- `renderStack.ts`, `spatialLayerProps.ts` → `core` (zod schemas; `core` already has zod).
  Re-export from `layers` and `vis` so MDV's imports don't move.

### Step 2 — three independent tracks

Assign these to different people. They do not conflict.

---

#### Track A — Points state model

1. **`RequestSlot<K, V>`** in `core`. One module replacing four hand-rolled
   dedup/supersede/settle implementations. **Supersession by record identity**
   (`if (this.current !== myRecord) return`), never by value comparison. Owns the
   `AbortSignal`. `error` is a state, not a `console.error`.
2. `PointsEntry`'s 18 mutable fields become four typed slots: `preload`, `catalog`,
   `rowCodes`, `matching`.
3. **`retryable` + `retry()`.** This — not the union — is what fixes the
   permanently-settled catalog failure. Do not skip it.
4. Threading the `AbortSignal` to the worker (punchlist D8). The worker protocol has
   no cancel message today.

**Races this must close** (all currently live, none reachable by the existing
845-line spec — write the tests through `RequestSlot`):

| # | Trigger | Symptom |
|---|---|---|
| R1 | cap drag 4M → 8M → 4M | stale `finally` wipes the live load's markers → second concurrent decode |
| R2 | deselect then re-select a feature mid-scan | two scans, same signature, corrupting each other's progress; loser's result silently dropped |
| R3 | raise the cap during a scan | served by the smaller scan; extra rows never fetched |
| R5 | filter toggled while preload is in flight | 4M row-codes overwrite an 8M preload → **row misalignment** |

5. **The partial-overlay flash** (punchlist D10), independently landable: one
   `GrowingPointsResource` per scan whose **loader identity is fixed for the scan's
   lifetime**, plus a `resourceRevision` prop so `PointsLayer` re-reads without
   resetting. One deck layer per *(entry, selection)*, not per *(entry, phase)* — so
   settling is not a teardown either. Zero teardowns per scan instead of N.

**Spike, behind the `RequestSlot` interface:** implement the slot twice — plain, and
Effect `Stream` + `Fiber` — for the **matching scan only**. Effect stays *inside* the
implementation; nothing leaks into a public signature (ADR 0004 §7 — `core` is also
`tgpu-htj2k`'s dependency root). **Kill criterion, agreed up front:** drop Effect
unless it wins on *all three* of — supersession correctness under two concurrent
scans; interruption that actually reaches the worker; fewer lines to set up a race in
a test. A tie means the plain slot wins.

---

#### Track B — Shapes

**Needs nothing from Track A. Can start immediately, in parallel.** Viewport-driven
loading requires no resolver change — it lives behind `loadInBounds()` inside deck's
`TileLayer`, exactly as ADRs 0002/0003 decided.

1. **The loader seam.** Mirror ADR 0003 for shapes: `CoreShapesLoader`
   (`capabilities` + `loadInBounds`), `ShapesBatch`, `ShapesRenderResource =
   { element, loader }`, strategy dispatch, and a `ShapesLayer` `CompositeLayer` that
   **loads inside itself** the way `PointsLayer` does.

   > Non-blocking is a *consequence*, not a feature. Move the load inside the
   > composite and the modal overlay disappears — which is precisely why `isBlocking`
   > already treats points differently from shapes.

   **First: delete or fix `loadShapesInBounds`.** It exists, ignores `bounds`, `zoom`
   and `columns`, does a full-element load, echoes the bounds back, and stamps
   `loadMode: 'full-filter'`. Zero callers, zero tests. It lies to anyone reading the
   interface.

   The seam lands with **one** adapter — a full-load loader honestly reporting
   `supportsViewportTiles: false`. The tiled loader is the *second* adapter, and is
   gated on a GeoParquet artifact (ADR 0002 marks shapes tiling *Future*).

2. **The batch representation.** `ShapePolygon = Array<Array<[number, number]>>` — one
   JS array object per vertex — is neither transferable nor cheap, which is *why*
   `VShapesSource` contains zero references to the worker while `VPointsSource`
   imports the whole worker client.

   **The requirement is only this:** the batch must be **transferable across the
   worker seam** and must **not allocate one JS object per vertex**. Nothing more is
   mandated.

   **Delegate where you can; hand-roll where you can't** (ADR 0004, Non-goals). The
   encoding decides, and ADR 0003's strategy registry — dispatching on
   `loader.capabilities.kind` — is already the mechanism:

   - Wild-type shapes are **WKB in parquet** with geopandas `geo` metadata, *not*
     GeoArrow. A decode is unavoidable. Whether you decode into GeoArrow buffers
     (and hand them to `GeoArrowPolygonLayer`) or into flat `positions` /
     `polygonIndices` typed arrays (and hand them to a binary `PolygonLayer`) is an
     open call — the decode cost is the same, and GeoArrow's layout *is* flat typed
     arrays with a schema. Prefer delegation if `deck.gl-geoarrow` can carry our
     feature-state, filtering and picking needs; **hand-rolled flat arrays are a
     sanctioned outcome if it cannot.** Establish this before building the batch.
   - **Points stay columnar.** They are x/y *columns*, not encoded geometry, so
     `GeoArrowScatterplotLayer` buys nothing over the existing `ScatterplotLayer`
     path. Do not convert them. (`geoarrow-binary` remains a stub for a reason.)

   This work also unblocks ADR 0005 rung 4 on the parquet path, and shrinks the
   picking buffer — which is the same problem as "keep hover live with no settle
   delay", not a separate one.

3. **Close the tooltip ping-pong.** Shapes tooltip data is cached by *element key* but
   requested per *layer config*, so two layers over one element with different
   `tooltipFields` invalidate each other forever. Labels have the identical shape.
   (`shapePrebuiltData` and `shapeFillColorData` were deliberately keyed by layer id to
   avoid exactly this; the tooltip cache was missed.)

---

#### Track C — Memory (ADR 0005 rungs 1–3)

**Leak fixes, not architecture.** Independent of A and B.

1. `MemoryReporting = { readonly byteLength: number }`. The scalar only. No tiers, no
   policy.
2. Byte-bounded LRU over `parquetTableBytes` and `parquetTableCache`. Fix the
   rejection-poisoning bug in the same pass.
3. Fill the empty chunk-cache seam: `enableWorkerChunkDecode({ cache })`. It is public,
   exported, documented, and **never passed** — so there is no zarr chunk cache at all
   today, and every tile re-fetches *and* re-decodes.

`tgpu-htj2k`'s `TileCache<V>` (~100 lines, framework-free, byte-bounded LRU with a
`dispose` hook, generic over payload) is directly reusable for 2 and 3.

**Stop at rung 3.** Rungs 4–5 (encoded tier, tiered `ResidencyReport`, Resource
Ceiling) wait for measurement. See ADR 0005 for why.

**File upstream to fizarrita** (ADR 0005 lists all four): the JP2K/HTJ2K blind spot in
`probeDecompressedSize` is the one that touches our actual imagery.

---

### Step 3 — Renderer Adapter cleanup (after Step 1)

- `project()` / `render()` formalised in `layers`. Identity-stable memoisation lives
  **here**, not in the resolver — it is a deck requirement.
- Delete the three `eslint-disable react-hooks/refs` render-phase ref writes and the
  `'use no memo'` React-Compiler opt-outs. If any survive, the snapshot is not
  identity-stable and something is wrong.
- The channel-merge ladder (`ch?.X && ch.X.length > 0 ? ch.X : loadedData.X`) is
  hand-written **ten times**. `mergeLayerChannelState` already exists in
  `avivatorish`, is exported from `vis`, and is unused.
- Dead surface: `reloadElement` (returned, typed, zero call sites), the unused
  `_coordinateSystem` parameter, `renderers/pointsRenderer.ts` (zero importers —
  punchlist F2).

---

## Definition of done

- [ ] `packages/core` has no `react`, no `deck.gl`, no `@hms-dbmi/viv` import. Still true.
- [ ] `packages/layers` has no `react` import. Still true.
- [ ] The resolver is exercised by a test that constructs no deck layer and no GL context.
- [ ] R1, R2, R3, R5 each have a failing-before / passing-after test written *through*
      `RequestSlot`.
- [ ] No `'use no memo'` remains in `packages/vis`.
- [ ] `useLayerData`'s 17-member surface is intact (compat shim is fine).
- [ ] `parquetTableBytes` and `parquetTableCache` report `byteLength` and are bounded.
- [ ] A failed catalog scan can be retried.

## Explicitly out of scope

- **Group Entry / blend compositing.** `CONTEXT.md` reserves it and says *"avoid:
  framebuffer layer until the rendering behavior exists."* That holds. `splatDensity.ts`
  in `tgpu-htj2k` is a GPU splat-by-blending primitive, **not** a prototype of Render
  Stack compositing — using it would mean adopting the whole WebGPU stack. A group
  layer-hierarchy is expected before long and may well be built on WebGPU; the Renderer
  Adapter seam is what makes it approachable. **Add no framebuffer hook in anticipation.**
- **ADR 0003's FBO-based render caching.** Still deferred, on its own terms.
- **Resource Ceiling / degrade-to-fit.** ADR 0005 rung 5. Measure first.
- **Effect in a public signature.** Anywhere.
