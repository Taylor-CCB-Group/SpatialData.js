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

## Known open — feature counts can settle permanently absent

Observed intermittently on a 12.1M-row Xenium `transcripts`: the feature panel
sticks on "sorted by count so far" and never reaches authoritative counts.
**Remounting the panel does not clear it**, which distinguishes it from the
preview-vs-full supersession bug fixed in `46d5b89`.

Mechanism (read from code; not yet reproduced deterministically):

1. `listPointsFeatures` tries `listPointsFeaturesByStreamingScan` first, which
   tallies counts as it scans, and falls back on any failure.
2. The fallback does not tally. `listPointsFeaturesWithCounts` then calls
   `loadFeatureCounts`, which needs an integer code column — so for a
   **dictionary-only** element (Xenium `transcripts`, merfish `cell_type`) it
   returns an empty map and the catalog settles with no counts.
3. `PointsResolver.ensureFeatureCatalog` short-circuits on
   `slot.settledKey === 'full'`, so that countless catalog is never re-requested.
   The failure is therefore permanent for the session, and remount-immune.

The non-determinism plausibly comes from `serverSupportsStreamingRanges`, a live
two-request probe memoised per ORIGIN in a static map: if it loses a race or is
throttled once, the whole origin is marked unservable for the session and the
countless path is taken. Suspected to have become more likely when `be64b65` put
the feature scan on that same probe, so it now runs earlier and more often —
**unverified**.

**Update (`8d1a875`).** Review on #89 identified the concrete mechanism, and it
is the one suspected above: the probe cached a *thrown* fetch as if it were the
server's answer, so a single failed request demoted the origin for the life of
the page. The probe now caches only definitive answers (a 416, or a 200 that
ignored `Range`); a thrown fetch evicts. That removes the most likely trigger,
but it does **not** close this item — it makes the countless path rarer without
making it recoverable. The permanence below is untouched, and any other route to
the fallback still produces the same stuck panel.

Two independent fixes, either of which removes the permanence:

- Do not settle `'full'` for a catalog missing counts it should have — settle it
  under an upgradable phase so a retry is possible. Makes it self-healing.
- Make the fallback path tally counts for dict-only elements, so falling back is
  a performance difference rather than a correctness one.

Deliberately not fixed blind: forcing `serverSupportsStreamingRanges` to false
should give a deterministic reproduction to fix against first.

## Defer-to-redesign

Each notes *why* it's coupled to the state-model / decode rework.

- **D1 — Mutable `PointsEntry` state model → Effect / TanStack Query.** The root
  above. In-code smells already flagged: `PointsDataEngine.ts` `// I'm a bit iffy
  about this ambient stateful thing` (onProgress), `// given ongoing problems with
  agent debugging, inclined to more purity. Might consider using
  Effect?`, `// there will be various mutating side-effects on entry…`.

  **Effect remains an open question, not a closed one.** Where an ADR or plan
  reads as having ruled it out, that is "not now", not "decided against" —
  revisit it on its merits when this item is picked up.

  Evidence from the #89 review, which is the argument for this item stated in
  defects rather than in taste. Four independent findings, one shape: *state
  arriving out of step with the thing it describes.*

  | Finding | The step it fell out of |
  | --- | --- |
  | Range probe cached a thrown fetch (`8d1a875`) | a failure outliving the request that caused it |
  | Worker `fromUrl` cache kept a rejection (`8d1a875`) | same, one layer down |
  | Matched batch drawn unfiltered without row codes (`615c926`) | codes vs the batch they align to |
  | `loadAll()` landing after its loader was replaced (`57f77fd`) | a read vs the resource it read from |
  | `rowCodes` readiness gate ignored the cap (this entry's sibling) | codes vs the window they mask |

  Each was individually cheap to fix and none were found by the type system,
  because in every case the stale value is the *correct type* — the cache, slot
  or state field simply has no way to say "this is no longer about the thing you
  are asking about". That is the property a principled effect/resource model
  makes structural instead of a per-site discipline, and it is why the fixes
  above are guards rather than a design change: five guards is evidence for D1,
  not a substitute for it.
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
- **D8 — Streaming cancellation semantics.** *Partly addressed on the Track A
  branch:* an `AbortSignal` is threaded to the scan generator, so supersede/evict
  abort it between chunks. What remains is the general case this entry was written
  about — the signal does not reach the WORKER, and an abandoned manual `.next()`
  loop still won't clean up. Design the rest with the new state layer.
- **D9 — Remove `'use no memo'` hatches (stable-snapshot option).** Give the
  engine stable-identity snapshot accessors so `useSyncExternalStore` tracks the
  value directly and the compiler stops needing an opt-out. Part of D1/D2.
- **D10 — Progressive-overlay visibility logic + flashing.** *The flashing is
  fixed on the Track A branch* — a scan-stable partial resource plus
  `resourceRevision` means the overlay updates in place instead of being torn down
  per chunk. The rest of this entry stands: the stable-growing-GPU-buffer work
  below is still the destination, and it is shared with D3. Historical description
  of the flash follows. F1 fixed the
  deselected-feature-lingering slice, but *which* points show during a partial
  load still has logic problems, and it **flashed badly**: every notify rebuilt
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
