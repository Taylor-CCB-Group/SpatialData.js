# Points — pre-merge punch-list & redesign backlog

Purpose: draw a clean line under the `points-feature-filter` PR before a larger
redesign. Everything here is either **fix-before-merge** (cheap, durable, or
stops a regression / stops the UI lying) or **defer-to-redesign** (entangled with
the state model, so patching now is throwaway).

## Root cause the redesign targets

Most of the "wrong points / wrong stats" issues are one problem, not many:
`PointsEntry` (in `PointsDataEngine.ts`) is an **imperative mutable record** whose
fields are flipped with side effects mid-flight — `matchingLoading`,
`partialResult`, the atomic-swap on `ensureLoaded`, `reconcileRowCodes`,
`onProgress` mutating `loading` in place. That state is read through the
**monolithic `useLayerData`** and kept reactive only via `'use no memo'` escape
hatches. The decision of *which points to show* and *what the stats say* is spread
across those mutation sites, so it's ad-hoc and easy to get subtly wrong.

The redesign — **break up `useLayerData`** and **spike Effect / TanStack Query**
scoped to this runtime — is what fixes the *class*. Individual selection/stats
bugs below marked "defer" are downstream of it: fix them there, with an explicit
state model, not by patching mutations here.

---

## Fix-before-merge

| # | Item | Where | Kind | Note |
|---|------|-------|------|------|
| F1 | **Deselected features reappear while a covering scan streams** | `useLayerData` getLayers partial overlay | render-breaking | The partial overlay draws the buffer with **no selection filter**, unlike the settled matched layer (which passes `featureCodes` + `preloadedFeatureCodes`). Deselect a feature whose scan is still in flight → engine keeps that scan ("covered"), its partial keeps the deselected rows, overlay shows them until settle. **Introduced by this PR.** Cheap fix: pass the same filter props to the overlay (the partial's own `featureCodes` are available). Or revert the overlay. |
| F2 | **Delete dead `pointsRenderer.ts`** | `vis/.../renderers/pointsRenderer.ts` | hygiene | `renderPointsLayer` + its interfaces have **zero importers** (superseded by `PointsLayer`). Safe delete; leaves a cleaner starting line. |
| F3 | **Stop the summary line lying** | `PointsLayerPanel.ShowMatchingPoints` (`t.loaded`) | cosmetic (wrong number) | `t.loaded` is the covered-batch size, not the count matching the current selection, so "Loaded all N …" is often wrong. *Proper* fix needs the engine to count selection-matched rows = redesign. For merge: make the line honest cheaply (show a number that's actually right, or drop the misleading clause). |
| F4 | **Resolve the working tree** | `PointsDataEngine`, `PointsFeatureFilterPanel`, `PointsLayerPanel`, `models/index`, `pointsRenderer` (all uncommitted) | hygiene | Includes dangling notes (`// how do I get the engine from the context?`). Commit-or-revert each so the branch is coherent. |

**Undecided (cheap either way):**

- **U1 — overlay compositing.** Today the partial is a *separate sub-layer on top
  of* the base (resident / prior matched), so during a scan you see both. Your
  call: keep base+partial, or show partial-only during a scan. Small render
  change in getLayers; orthogonal to F1 (F1 is about *filtering* the partial,
  this is about *whether the base also draws*). Fine to defer.

---

## Defer-to-redesign

Each notes *why* it's coupled to the state-model / decode rework.

- **D1 — Mutable `PointsEntry` state model → Effect / TanStack Query.** The root
  above. In-code smells already flagged: `PointsDataEngine.ts` `// I'm a bit iffy
  about this ambient stateful thing` (onProgress), `// given what a shit-show
  agent debugging has been… inclined to more purity. Might consider using
  Effect?`, `// there will be various mutating side-effects on entry…`.
- **D2 — Break up `useLayerData`.** The monolith the engine threads through; also
  the reason for the `'use no memo'` hatches (`PointsFeatureFilterPanel`,
  `ShowMatchingPoints`). A properly reactive state layer retires the hatches.
- **D3 — Progressive *initial* load (`loadPoints`).** Currently one-shot (bulk
  fetch + single worker decode); making it progressive needs a per-part decode
  loop **and** a general engine "partial resident" slot (the partial mechanism is
  matching-specific today). The engine rework owns this. `pointsScanChunkProgress`
  is already the reusable producer helper when we get there.
- **D4 — Progressive / active feature stats before the full catalog scan
  completes.** Today stats only appear once the whole-dataset catalog settles;
  there's real use in showing progressive/active counts. Tied to D3 (progressive
  catalog build) and the stats state model (F3's proper fix).
- **D5 — Tiled (Morton) viewport-driven loading.** The tiled path isn't exercised;
  viewport-driven load is a major feature and exactly the kind of demand-driven
  state the new model should own (Morton tiling is still "dark" per the roadmap).
- **D6 — Worker contention with multiple layers.** Multiple point layers share
  one worker; the engine keys by element and assumes single-demand-per-element.
  Multi-layer sharing / a work queue belongs with the engine redesign.
- **D7 — GeoArrow encoding.** Unexplored; a decode-path spike, not this PR.
- **D8 — Streaming cancellation semantics.** The generators have no `AbortSignal`
  threaded to the worker, and an abandoned manual `.next()` loop won't clean up.
  Fine while consumers drain; design it with the new state layer.
- **D9 — Remove `'use no memo'` hatches (stable-snapshot option).** Give the
  engine stable-identity snapshot accessors so `useSyncExternalStore` tracks the
  value directly and the compiler stops needing an opt-out. Part of D1/D2.
- **D10 — Progressive-overlay visibility logic + flashing.** F1 fixed the
  deselected-feature-lingering slice, but *which* points show during a partial
  load still has logic problems, and it **flashes badly**: every notify rebuilds
  the partial buffer into a fresh `PointsRenderResource` (new identity each
  chunk), so deck tears down and recreates the `__partial` layer per step instead
  of updating it in place. The real fix is a stable growing GPU buffer (preallocate
  to cap, append, bump a draw count via `updateTriggers`) rather than a
  rebuilt-per-chunk resource — which is the same append-buffer work noted for D3
  and the `pointsScanChunkProgress` O(chunks²) concat. Owned by the engine +
  render redesign; the current overlay is a spike, not the destination.

---

## Suggested merge line

Do **F1–F4** (+ decide **U1**), confirm no regression vs `main`, tests + types
green. That yields a merged state that is *correct, honest, coherent, and
non-regressed* — without trying to make the selection logic *right*, which rides
the redesign (D1/D2). Everything in **Defer** stays untouched.
