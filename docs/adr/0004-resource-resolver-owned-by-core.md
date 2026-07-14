# Resource Resolver Owned By Core

**Status:** proposed
**Amends:** [ADR 0001](0001-render-stack-owned-by-layers.md) — its *package-placement* claim only; its substance stands.
**Builds on:** [ADR 0002](0002-spatially-aware-vector-loading.md), [ADR 0003](0003-points-render-resource.md)

The **Resource Resolver** — the module that turns structural **Render Stack** inputs
into stable loaded resources — lives in `@spatialdata/core`, not
`@spatialdata/layers`. `@spatialdata/layers` keeps the deck.gl **Renderer Adapter**.

## Context

`CONTEXT.md` already draws this line, and we drifted from it:

> **Resource Resolver**: The **store-agnostic** boundary that turns structural
> Render Stack inputs into stable loaded resources **for renderers**.
>
> **Renderer Adapter**: The code that turns resolved resources plus entry props
> into Viv/deck layer instances. *Avoid: state store.*
>
> A **Spatial Entry** is resolved by a **Resource Resolver** *before* a
> **Renderer Adapter** creates Viv/deck output.

Two steps, explicitly, with the state store on the resolver side and explicitly
forbidden on the renderer side.

Today the Resource Resolver does not exist as a module. Its responsibilities are
split between `useLayerData.ts` (1,873 lines, `@spatialdata/vis`) and
`PointsDataEngine.ts` (940 lines, `@spatialdata/layers`). Neither is where the
domain model says it should be.

### Consequence 1 — the god-hook

The four **Spatial Entry** kinds are not separate modules. They are four
implementations braided line-by-line through one body, joined at six shared
mutable mechanisms: a `toLoad` tuple whose six booleans every push site must
spell out, one `layerLoadStates` map, one six-Map `loadedDataRef`, one revision
counter, one `getLayers` loop, and four kind-switches. Points work and shapes
work cannot proceed concurrently without conflicting.

### Consequence 2 — a second Resource Resolver already exists

This is the decisive one, and it is not a matter of taste.

`tgpu-htj2k` renders 1.5 Gpx HTJ2K imagery from a real Xenium SpatialData store
through three.js/WebGPU **today**. It depends on `@spatialdata/core` and
`zarrextra`, and its ADR-0010 excludes the rest by name:

> "No deck.gl / React enters the render path … `@spatialdata/layers` /
> `@spatialdata/vis` / `@spatialdata/avivatorish` are excluded."

It reached into `@spatialdata/core` for a resolution layer, found only `readZarr`
plus element discovery, and **hand-rolled the entire thing**: `Select`,
`Selection`, `Resolve`, `Tileset`, `TileCache`, `loadScheduler`, Nyquist LOD,
byte budgets. Roughly ten files, with tests.

That is a second Resource Resolver, written from scratch because the first one
was locked behind deck.gl. The duplication is being paid for now, in another
repo.

### The resolver is not deck-shaped

Every type in the per-kind resource maps is a `core` type — `PointsLoadResult`,
`PointsFeatureCatalog`, row codes, `ShapesRenderData`, `ShapesTooltipMetadata`.
Not one is a deck type. Every case of the failure union is a `core` concept —
coordinate-system-not-found, element-not-found, unsupported-format,
points-preload-too-large, decode-failed, worker-unavailable. Not one is a deck
concept.

## Decision

1. **The Resource Resolver lives in `@spatialdata/core`.** Framework-free: no
   React, no deck.gl, no Viv. It owns the cache, request supersession,
   cancellation, streaming partials, eviction, entry resolution
   (element + transform to the active coordinate system), and world bounds.

2. **Per-kind resolvers behind one interface** — points, shapes, images, labels —
   not one monolithic engine. A single engine would move the four-way kind-switch
   down a package rather than dissolve it, and would keep points and shapes in
   one file. (This resolves open question 2 of
   [`docs/plans/layer-data-engine-decomposition.md`](../plans/layer-data-engine-decomposition.md).)

3. **`Resolution<T>` and `SpatialEntryError` are `core` types.** Failure is
   **per-resource**, not per-entry: a shapes entry with a broken tooltip column
   must still draw its geometry. See [ADR 0005](0005-memory-accounting-before-management.md)'s
   sibling note and `CONTEXT.md` for the vocabulary.

4. **The Renderer Adapter stays in `@spatialdata/layers`.** It owns `project()`
   (prebuilt datum arrays, feature-state runtime, render-resource identity memos)
   and `render()` → `Layer[]`. Identity-stable memoisation is a **deck
   requirement** — deck tears a layer down when its data identity changes — so it
   belongs on the renderer side, memoising against core's per-entry snapshot
   identity.

5. **`RenderStack` moves to `core`.** Forced by dependency direction: the
   Resolver takes a Render Stack as input. This also lands where the schemas
   already wanted to be — `renderStack.ts` and `spatialLayerProps.ts` are zod
   persistence schemas that `vis` re-exports verbatim because MDV consumes them
   as a *data contract*, and `core` already owns `schemas/` and depends on zod.

6. **The image loader is a port.** `createImageLoader` closes over the React
   `VivLoaderRegistry` context. `core` defines the port; `vis` supplies the
   adapter. This is the one genuine ports-and-adapters dependency; everything
   else is local-substitutable (tests stub elements as plain object literals).

7. **No runtime dependency enters `core`.** No Effect, no `neverthrow`, no
   TanStack in a public signature. `core` is the dependency root for
   `tgpu-htj2k` as well as `layers`, and that repo's engine core is deliberately
   dependency-free. A library may be used *inside* a resolver's implementation
   (see the `RequestSlot` spike) but must not appear in `core`'s interface.

## What ADR 0001 retains

Its substance is unchanged:

- **Host Overlays** are saved as descriptors and resolved by the host application
  at runtime. MDV still interleaves scatter, gates and selections without storing
  raw deck layer instances.
- No parallel `layerOrder` / `stackOrder` state.
- MobX is not part of the contract. **MobX Control Islands** remain explicit,
  especially under React Compiler.
- `@spatialdata/vis` adapts the stack into React, Viv and deck.gl rendering.

Only this sentence changes: *"The canonical ordered render description lives in
`@spatialdata/layers`"* → **it lives in `@spatialdata/core`.**

## Renderer Adapters — why the seam is real

"One adapter means a hypothetical seam. Two adapters means a real one."

| Adapter | Status |
|---|---|
| deck.gl (`@spatialdata/layers`) | shipping |
| Viv image props (`@spatialdata/layers`) | shipping — and *already a distinct output shape*: images do not produce `Layer[]`, which is why every interface sketch grew an awkward optional `buildVivProps?` |
| three.js / TSL (`tgpu-htj2k`) | shipping |
| headless (no renderer) | shipping — and today cannot reach any of this logic |

Four adapters, three of them live. The Viv wart is worth dwelling on: it was the
renderer seam asserting itself through an interface that refused to acknowledge
it.

## Out of scope

- **Group Entry compositing / blend rendering ops.** `CONTEXT.md` reserves
  **Group Entry** and says plainly: *"Avoid: framebuffer layer until the
  rendering behavior exists."* That still holds. `tgpu-htj2k`'s
  `splatDensity.ts` is a GPU splat-by-blending **primitive**, not a prototype of
  Render Stack compositing, and adopting it would mean adopting the whole WebGPU
  stack. A group layer-hierarchy — where blend ops would live — is expected to
  become live before long, and may well be built on WebGPU. The Renderer Adapter
  seam is what makes that approachable later. **Nothing in this ADR builds it,
  and no framebuffer hook is added in anticipation of it.**

- **Viewport-driven loading needs no resolver change.** Points already do it and
  the resolver never sees a viewport — it lives behind `PointsLoader.loadInBounds()`
  inside deck's `TileLayer`, exactly as ADRs 0002/0003 decided. Shapes get it the
  same way. If a future kind genuinely needs engine-level viewport reconcile, the
  resolver's input grows an optional `viewport?` field that existing resolvers
  ignore.

- **ADR 0003's "FBO-based render caching"** remains deferred, on its own terms.

## Cross-repo consequence

`tgpu-htj2k` ADR-0008's cross-repo layering table assigns `Select` / `Tileset` /
`TileCache` / render backends to `tgpu-htj2k` as their **permanent** home. That
was decided when the only SpatialData.ts equivalent lived behind deck.gl. If the
Resolver moves to `core`, the table should be renegotiated: **resolution to
`core`, render backends stay.** This ADR does not unilaterally amend another
repo's decision; it flags it as owed.

## Consequences

- `@spatialdata/core` gains a **stateful, subscribable module**. This is a change
  of character for a package that is today models + loaders + workers. It is the
  right change — `CONTEXT.md`'s Resource Resolver *is* a store concept — but it
  should be made deliberately, not slid into.
- The resolver becomes testable **headless**, with no deck.gl and no GL context.
- `@spatialdata/vis`'s public surface is preserved for MDV via a compat shim; do
  not silently relocate an exported type out of `vis`.
- The unmanaged caches already living in `core` (`parquetTableBytes`,
  `parquetTableCache` — both unbounded, never evicted) gain an owner. See
  [ADR 0005](0005-memory-accounting-before-management.md).
- `useLayerData` collapses to a thin React binding: create, reconcile,
  `useSyncExternalStore`, project. The three `eslint-disable react-hooks/refs`
  render-phase ref writes and the `'use no memo'` React-Compiler opt-outs go with
  it.

## Provenance

Surfaced during an architecture review on the
`claude/codebase-architecture-refactor-36013b` branch, 2026-07-14. The interface
was designed four ways in parallel under four different constraints (minimise the
interface; maximise extensibility; optimise for the caller; error-as-value spine).
All four independently produced per-kind resolvers behind a uniform interface with
per-resource resolutions — the convergence is the evidence for decisions 2 and 3.
