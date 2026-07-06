# Points MVP & roadmap

**Status:** agreed (grilling session 2026-07-06); implementation not started
**Related:** [CONTEXT.md](../../CONTEXT.md) (domain terms), [ADR 0002](../adr/0002-spatially-aware-vector-loading.md), [ADR 0003](../adr/0003-points-render-resource.md), [LayerDataEngine decomposition](layer-data-engine-decomposition.md), [points preload & feature filter status](points-preload-feature-filter-status.md)

This document defines the **minimum viable feature set** for interactive points
(transcript) layers and the roadmap around it. It is the product-scope companion
to the [LayerDataEngine decomposition](layer-data-engine-decomposition.md) plan,
which owns the *structural* mechanics; this doc owns *what we ship and in what
order*.

Domain terms (**Points Feature**, **Feature Code**, **Point Attribute Column**,
**Feature Highlight**, **Instance Key**) are defined in [CONTEXT.md](../../CONTEXT.md)
and used here without re-definition. Note in particular: a **Points Feature** is
the value of the column named by the element's `.zattrs` `feature_key` — *not
assumed to be a gene name* (it may be a protein, probe, or arbitrary categorical
label).

---

## MVP feature set

| # | Capability | Keys on | New vs reuse | Data-flow |
|---|------------|---------|--------------|-----------|
| 1 | **Filter** by Points Feature | Feature Code / catalog | wire existing composite `featureCodes` | in-memory filter over the preloaded batch (preloaded scatter); per-tile `featureCodes` in the viewport (Morton) |
| 2 | **Colour** by Points Feature — auto palette | Feature Code | **new** in `pointsScatterLayer` | serializable colour encoding on the Stack Entry; `getFillColor` keyed by Feature Code; palette cycles on overflow (collisions accepted) |
| 2b | **Feature Highlight** (interactive) | Feature Code | **new** | *runtime/ephemeral* `highlightedFeatureCode`; `updateTriggers` on colour/size accessors; **no reload / no refilter** |
| 3 | **Identify** — hover → Points Feature value | resident batch | pick-wire + reuse tooltip UI | deck hover pick → catalog label for the point's Feature Code; drag-gated like shapes |

**Substrate:** all three ride the `@spatialdata/layers` **`PointsLayer` composite**
(reached via `resolvePointsRenderResource`), *not* the legacy flat
`renderPointsLayer`. The composite already models filter + pick and is where the
future FBO strategy slots in (ADR 0003), so this wiring is not throwaway.

### Why colour + highlight instead of a big palette

A transcript catalog is ~hundreds of features; a categorical palette offers
~20–40 distinguishable hues. We do **not** try to give every feature a unique
colour. Distinguishability comes from **interaction**: an auto palette makes the
layer pleasant, and **Feature Highlight** lets the user pull one feature out of
the crowd on demand. Highlight is a *cheap recolor of the already-resident batch*
— the same "recolor without reload" path the FBO redo and the MDV active-link
both depend on, so this small MVP interaction de-risks the big roadmap items.

### Colour is serializable; highlight is runtime

- **Colour encoding** (`{ mode: 'flat', color } | { mode: 'by-feature', palette }`)
  is serializable `entry.props` — it persists in the Render Stack.
- **Feature Highlight** is transient runtime state (a **Runtime Attachment** /
  MobX Control Island concern) — it must **not** persist into the Stack Entry.

This split is captured in [CONTEXT.md](../../CONTEXT.md); it is deliberate and
load-bearing (it decides what MDV can drive live vs what a saved config carries).

---

## Cross-cutting constraints (in MVP)

- **Frame-budget rule.** Nothing blocks the main thread for a significant time.
  Aim for the frame budget; a ~500ms hitch on an *explicit button press* is the
  outer tolerance, anything worse is a defect. The historical **~30s catalog
  stall** on plain 12M-row `transcripts` is a *symptom of building the dictionary
  on the main thread*, not an inherent cost.
- **Worker offload + status reporting.** Catalog build and parquet decode run on
  the points worker, with coherent load-state/progress surfaced to the UI. This
  promotes the status doc's P1 ("unify worker policy") and the load-state UI into
  MVP scope. (Worker is opt-in per host after commit `8829ff9`; the demo enables
  it — a dead/opted-in worker must still fall back via a **timeout**, not hang.)
- **Two independent perf axes** — do not conflate:
  - *Load-time blocking* (catalog/decode) → worker offload + status. **In MVP.**
  - *Draw-time overdraw* (zoomed-out, deck redraws every point every frame) →
    proper fix is **FBO tile rasterisation** (ADR 0003), **post-MVP**. MVP
    stopgap: **filter-reduces-overdraw** (the dominant "few features" use case
    draws far fewer points) + existing render cap + point-size control. No LOD /
    decimation in MVP.

---

## Deferred (noted, not MVP)

- **Configurable Point Attribute Column tooltip** — full "option C": a
  `TooltipFieldsPanel`-driven set of attribute columns loaded *aligned to the
  resident batch* (same pattern as `loadRowFeatureCodes`), pick → O(1) index.
  This is the only genuinely new *loader* work in the tooltip story, hence
  deferred. Reuses `TooltipFieldsPanel`, `SpatialFeatureTooltip`,
  `SpatialFeatureTooltipData`. When built, the tooltip-column set becomes
  serializable config.
- **Lazy per-row attribute fetch** — "option B": fetch a single picked row's
  columns on demand. Needs **row-addressable parquet reads** (row-group +
  in-group offset), awkward for the dictionary/multipart layout. Post-MVP.
- **Manual per-Feature colour assignment** (click a feature → pick its colour).
- **MDV active-link** — Points Feature ↔ `table.vars`. There is (as far as we
  know) no schema mechanism expressing this relationship; it is a
  community-discussion item and a research question, not MVP. The MVP's
  resident-batch + Feature Highlight is the substrate it will later plug into.
- **Instance Key behaviour** (`instance_key`, e.g. `cell_id`) — reserved.
- **FBO tile rasterisation** for overdraw (separate plan; ADR 0003 §FBO).
- **Feature-primary / compound index strategy selection** — the open ADR
  0002/0003 question of how the resolver chooses among preloaded / Morton /
  feature-primary and how writers advertise indexes.

---

## Implementation sequence

Each step builds and passes tests on its own; the branch never sits broken.

1. **Parity slice.** Extract a **points-only** `LayerDataEngine` into
   `@spatialdata/layers` (cache + orchestration as plain fields, no React), wire
   the composite via `resolvePointsRenderResource`, and replace the legacy
   `renderPointsLayer` call in `useLayerData`. **Acceptance: points still draw and
   "Center on layer" still works, with no behaviour change**; add headless unit
   tests that were impossible against the hook. Leave shapes/images/labels on the
   existing hook path (decompose only what we touch). Commit.
2. **Filter.** Catalog build (worker + status) → `featureCodes` → composite
   filter. Filter/catalog panel UI (points equivalent of the shape panels).
3. **Colour + Highlight.** Auto-palette `by-feature` colour encoding (serializable)
   in `pointsScatterLayer`; runtime `highlightedFeatureCode` wired to
   `updateTriggers`; catalog-panel hover drives highlight.
4. **Identify tooltip.** Hover pick → Points Feature value via the catalog label,
   rendered through the existing tooltip UI, drag-gated via `featureTooltipHover`.

Steps 2–4 progressively apply the target design (engine-owned orchestration) to
exactly the functionality being touched, per the incremental decomposition
strategy — not a big-bang rewrite of the god-hook.

---

## Open questions (carried, not blocking MVP)

1. Default filter state on first load — all features on, or a bounded subset
   when the catalog is large? (Leaning: all on, since filter is the overdraw
   escape hatch and "all on" is the least surprising.)
2. Worker-backed catalog: dictionary-from-metadata fast path vs. same-bytes
   off-thread decode. (Status doc P0 recommends metadata fast path first.)
   **Finding (2026-07-06, live on a real Xenium `transcripts`):** the current
   worker catalog path (`readParquetWorkerPayload` with `fullPartsForFallback` →
   `scanParquetFeatureCatalogInWorker`) fetches the **entire** parquet file
   before scanning, whereas the main-thread path does a *projected* single-column
   range read of just the feature column. For a transcripts element with **no
   `{feature_key}_codes` column** (so the cheap row-group *dictionary-page* scan
   can't run), enabling the worker regressed catalog build from ~20s to >150s.
   The request timeout in `pointsWorkerClient` (added this cycle) makes a silent
   worker fall back safely, but does **not** fix this — the fetch is before the
   worker call. **Next perf task:** give the worker a *projected/dictionary-only*
   payload path (fetch only the feature column, or read dictionary pages) so
   worker-offload is a win, not a regression — only then enable the worker in the
   demo for catalog building. Until then the demo keeps the (blocking but faster)
   main-thread path.
3. Engine submodule placement and one-object-vs-per-type facade — deferred to the
   decomposition plan's open questions.
