# LayerDataEngine decomposition — moving orchestration out of the vis god-hook

**Status:** proposed (not started)
**Related:** [ADR 0002](../adr/0002-spatially-aware-vector-loading.md), [ADR 0003](../adr/0003-points-render-resource.md), [points preload & feature filter status](points-preload-feature-filter-status.md)

This plan addresses a structural problem surfaced while trying to rebase the
oversized points-loading branch onto current `main`: **substantial data-loading,
caching, and orchestration logic lives inside a React hook in `@spatialdata/vis`
(`SpatialCanvas/useLayerData.ts`) when it should sit at the `@spatialdata/layers`
level.** The render strategies and store loaders are already correctly placed;
the *orchestration/resolver* layer on top of them is not.

---

## What is already correctly placed (do not touch)

The points **render** path was decomposed along ADR 0003's lines and is fine:

| Layer | Owns | Files |
|-------|------|-------|
| `@spatialdata/core` | Store I/O loaders | `pointsLoader`, `pointsTiling`, `pointsFeatures`, `pointsLimits`, `pointsLoadOptions`, `parquetWasmLoader`, `VPointsSource` (`loadPoints`, `loadRowFeatureCodes`, `listFeatures`, `loadPointsInBounds`) |
| `@spatialdata/layers` | Render strategies + deck composite | `preloadedScatterStrategy`, `mortonTiledStrategy`, `geoArrowStrategies`, `pointsLoaderAdapter`, `pointsRenderStrategies`, `pointsScatterLayer`, `PointsLayer`, tile-debug modules |

`layers` has **no React dependency** (deck.gl only) — confirmed by absence of any
`from 'react'` import in `packages/layers/src`. This is what makes it a valid home
for a framework-agnostic engine.

---

## What is mis-placed

The **orchestration / resolver layer** — deciding *what* to load, caching it, and
resolving it into render resources — is scattered across `vis/SpatialCanvas`:

- **`useLayerData.ts`** — ~2281 lines on the WIP branch (~1652 on `main`), with
  **6 `useEffect`, 16 `useRef`, 3 `useMemo`**. It holds an 8-map cache
  (`loadedDataRef`: `shapes`, `points`, `pointTilingMetadata`, `images`, `labels`,
  `shapePrebuiltData`, `shapeFillColorData`, `worldBounds`) plus signature and
  stable-reference caches, and orchestrates preload → catalog → row-codes → filter
  for every element type. The WIP branch added **~286 lines of points
  orchestration** into this hook (vs ~13 for shapes).
- **`pointsLoadPlan.ts`** and **`resolvePointsRenderResource.ts`** — already
  React-free, importing only `@spatialdata/core` and `@spatialdata/layers`, but
  filed under `vis`.

### Why this is wrong

1. **Framework-agnostic logic is welded to React.** The cache and orchestration
   are plain data structures and async flows; they live inside a hook as
   `useRef`/`useEffect` purely for lifetime management. React is the only reason
   they are in `vis`.
2. **Unreachable and untestable headless.** `main` already ships a headless
   viewer, but none of this logic can run from it, and none of it has unit tests
   because it is trapped in a hook.
3. **It contradicts ADR 0003.** The ADR specifies a *thin* vis resolver that
   "associates element + loader" and "probes once and returns a bundle
   `{ element, loader }`". That resolver has become a god-hook. Shapes
   (`loadShapesLayerData`, `loadShapeFillColorData`, feature-state merge) were
   never extracted at all.

---

## Target decomposition

| Concern | Today | Target home |
|---------|-------|-------------|
| Store I/O loaders (`loadPoints`, `loadPointsInBounds`, `listFeatures`, row codes) | `core` ✓ | **`core`** (keep) |
| Render strategies + `PointsLayer` | `layers` ✓ | **`layers`** (keep) |
| Load-plan + render-resource resolution (`pointsLoadPlan`, `resolvePointsRenderResource`) | `vis` (React-free already) | **`layers`** — move verbatim |
| Loaded-data cache (8 maps, world-bounds, signatures) | `vis` (React refs) | **`layers`** — plain cache, no React |
| Preload / catalog / row-code orchestration (~286 lines) | `vis` hook effects | **`layers`** — engine methods |
| Shape fill-color, feature-state merge/runtime, pick-event shaping | `vis` hook | **`layers`** (render-domain) |
| React binding: subscribe, trigger on config change, return props | `vis` | **`vis`** — thin hook only |

### The unifying move: `LayerDataEngine`

A framework-agnostic **`LayerDataEngine`** in `@spatialdata/layers` owns the cache
and orchestration behind an imperative API. Rough shape:

```ts
interface LayerDataEngine {
  // Feed it the current desired state (layer configs, coordinate system, viewport).
  updateConfig(input: LayerDataInput): void;
  // Pull current render inputs (deck layer props / render resources) synchronously.
  getLayerInputs(): LayerInputs;
  // Notify when async loads settle so a host can re-render / re-pull.
  subscribe(listener: () => void): () => void;
  // Load-state introspection for UI (durations, pending/loaded/error per layer).
  getLoadState(): LayerLoadState;
  dispose(): void;
}
```

- The engine holds what is today `loadedDataRef` and the signature/stable-ref
  caches as **plain fields** — no React.
- It calls `core` loaders and `layers` strategies; it does not import React or
  deck React bindings.
- `useLayerData` collapses to a **thin adapter**: create/hold the engine in a
  ref, call `updateConfig` in one effect, `subscribe` to force re-render, return
  `getLayerInputs()` / `getLoadState()`. Target well under a few hundred lines.

Because `layers` is React-free, the engine is unit-testable and usable from the
headless viewer.

---

## Why this is worth doing (beyond tidiness)

The engine is the seam the two roadmap goals need:

- **FBO splatting** ([ADR 0003 "FBO-based render caching"](../adr/0003-points-render-resource.md))
  plugs in here — the engine's tile cache becomes "splat tile → framebuffer"
  instead of threading tile state through React. Reusable framebuffer helpers
  attach to the engine, not the hook.
- **MDV "active link"** (selected genes ↔ `table.vars`) lives here — the engine
  keeps cached points resident, so a gene-selection recolor is an engine call,
  not a geometry reload. The same cache is the pick buffer.

So this decomposition is groundwork for the FBO redo, not a detour from it.

---

## Sequencing

> **Correction (2026-07-03):** current `main` is **bare of the entire points
> render path** — none of the `core` loaders or `layers` strategies exist there
> (the harvest took only python/docs/default-CS). So the two resolver modules
> cannot move to `layers` in isolation; their dependency chain is absent. The
> reconstruction must proceed in dependency order, core-first. Revised steps:

0. **DONE — `core` points I/O foundation** (commit `4cc91eb`). Points
   loaders/tiling/features + worker, bounded/capped loading on
   `VPointsSource`, and the vendored parquet-wasm, brought onto current `main`.
   Typecheck clean, 120 core tests pass. This is the dependency root.
1. **`layers` strategies + relocate the two resolver modules here.** Bring the
   render strategies (`preloadedScatterStrategy`, `mortonTiledStrategy`,
   `geoArrowStrategies`, `pointsLoaderAdapter`, `PointsLayer`, tile-debug) onto
   `main`, and land `pointsLoadPlan.ts` + `resolvePointsRenderResource.ts` in
   `layers` (not `vis`) — they already import only `core`/`layers`, so this is
   the proof-of-direction placement. Re-export from `vis` for MDV consumers.
2. **Introduce `LayerDataEngine` in `layers`** with the cache + points
   orchestration extracted from `useLayerData`. Convert the points path of the
   hook to a thin binding over the engine. Add unit tests exercised without React.
3. **Migrate shapes** (`loadShapesLayerData`, `loadShapeFillColorData`,
   feature-state merge/runtime, pick-event shaping) into the engine the same way.
4. **Migrate images/labels** orchestration for completeness, so the hook is a
   uniform thin adapter across all four element types.
5. **Plug the FBO points path into the engine** (separate plan) rather than into
   the hook.

Land this **through** the decomposition rather than by mechanically rebasing the
old branch's hook changes onto current `main`. The mechanical rebase was attempted
and abandoned (see "Provenance" below); it would have poured effort into the
god-hook we intend to dismantle.

---

## Risks and constraints

- **`vis` public API / MDV.** Some symbols (e.g. `LayerLoadState`,
  `useSpatialCanvasRendererFromLayerInputs`, pick-event types) are consumed by
  MDV (see the Track A public-API work). Keep `vis` re-exporting anything moved,
  or coordinate the move with the MDV integration. Do not silently relocate an
  exported type out of `vis`.
- **Behavioral parity first.** Extract without changing load behavior, so the
  known-broken basic points loading and the Morton-slowness questions can be
  diagnosed against a faithful port. Performance/strategy changes come after.
- **Cache lifetime.** React refs currently pin cache lifetime to the hook/component.
  The engine must be explicitly created/disposed by the host; get disposal right
  to avoid leaks across coordinate-system / dataset switches.
- **Incremental, not big-bang.** Each step (1–4) should build and pass tests on
  its own so the branch never sits in a broken intermediate state for long.

---

## Open questions

1. Does `LayerDataEngine` belong at the top level of `@spatialdata/layers`, or in
   a dedicated submodule (e.g. `layers/src/engine/`)? Leaning submodule.
2. Should the engine be one object across all element types, or composed of
   per-type sub-engines (points/shapes/images/labels) behind a facade? Composed is
   likely cleaner and matches the migration order.
3. How much of the load-state/timing UI contract (`LayerLoadState`,
   `formatLoadDurationMs`, `GeometryLoadStats`) should move vs. stay as a vis
   presentation concern reading engine state?
4. Where do the still-open ADR 0002/0003 strategy-selection questions
   (feature-primary vs Morton vs preloaded) get decided — engine `updateConfig`
   input, or resolver probe? Probably the resolver, now living in `layers`.

---

## Provenance

Discovered 2026-07-03 while assessing whether to rebase the points-loading branch
(`backup/points-wip-20260702`) onto current `main` after its safe slices were
harvested into separate PRs (#75 default-CS, #76 experimental-writer, #77 ADRs).
A mechanical reconstruction (bring 74 render-path code files onto current `main`,
3-way-merging 8 overlap files) was set up and then abandoned in favour of this
decomposition. The WIP is preserved on branch `claude/quizzical-roentgen-3ee079`
and tag `backup/points-wip-20260702`.
