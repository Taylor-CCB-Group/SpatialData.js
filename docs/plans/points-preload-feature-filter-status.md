# Points preload & feature filter — status and plan

**Status:** work in progress (branch/worktree, not yet on `main`)  
**Last updated:** 2026-06-20  
**Related:** [ADR 0002](../adr/0002-spatially-aware-vector-loading.md), [ADR 0003](../adr/0003-points-render-resource.md)

This document captures what we built, what broke, what we fixed, and what still
needs cleanup — especially around **workers**, **parquet I/O**, and the **~30s
main-thread catalog load** on large Xenium `transcripts`.

---

## Problem statement

On ~12M-row Xenium `transcripts`:

1. **Feature filter was unusably slow** — every checkbox toggle re-scanned the
   full parquet dataset via `loadPoints({ featureCodes })`.
2. **Parquet was used incorrectly** for large reads — whole part files fetched
   and decoded instead of row-group range reads with column projection.
3. **Feature catalog UI** failed or showed a single blank gene on the normal
   `transcripts` element (dictionary-encoded `feature_name`, no separate codes
   column).

---

## Target architecture questions (current intent)

The current implementation separates three concerns for the preloaded scatter
path:

| Concern | When | Where |
|---------|------|--------|
| **Geometry preload** | Once per `(element, memoryCap)` | `loadPoints` → x/y only, capped (default 4M rows) |
| **Runtime feature filter** | Every checkbox toggle | `PointsLayer` → in-memory filter on preloaded batch |
| **Feature catalog** | Once per element (UI gene list) | `listFeatures` → feature columns only, not x/y |

This is a useful strategy when a bounded preload fits comfortably in memory and
the user wants fast toggling across a moderate number of visible points. It is
not the general architecture for all points stores.

The broader architecture should support multiple point loading strategies:

| Strategy | Filter-change behavior | Runtime batch/layout | Good fit |
|----------|------------------------|----------------------|----------|
| **Preloaded scatter** | Does not reload geometry; filters an in-memory capped batch | `columnar-ndarray` today; possible Arrow/GeoArrow batch later | Moderate point counts, exploratory toggling, local responsiveness |
| **Spatial Morton tiles** | Reloads viewport tiles when filter props change | `columnar-ndarray` tile batches today; possible GeoArrow tile batches later | Spatial navigation where row groups are primarily spatial |
| **Feature-primary or compound index** | Intentionally loads new data for selected features | Same loader contract; likely benefits from Arrow/GeoArrow columnar batches | Looking at a few genes/features out of thousands without keeping all features in memory |

The open design question is how the resolver chooses among these strategies and
how writers advertise their indexes. We should not assume that every feature
filter is a view over already-loaded data.

### Runtime batch/layout direction

Persisted optimized points remain Parquet-backed for now. GeoArrow is relevant
as a **runtime columnar layout** and deck.gl integration boundary, not as a
separate persisted copy of the same data. The `PointsLoader` / `PointsBatch`
contract should be able to return Arrow-ish or GeoArrow-compatible batches
later, while `@spatialdata/layers` owns deck.gl-geoarrow adaptation. This keeps
`@spatialdata/core` deck-free and lets each strategy evolve from current
`columnar-ndarray` batches toward GeoArrow where that proves faster or simpler.

```
┌─────────────────────────────────────────────────────────────────┐
│  Vis (useLayerData)                                             │
│  ├─ loadPoints({ memoryCap })     once, key = element|m{cap}    │
│  ├─ loadRowFeatureCodes({ cap })  after preload, aligned rows   │
│  └─ listFeatures()                catalog for filter panel      │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│  PointsLayer (preloaded scatter path)                           │
│  ├─ preloadedBatch        from render resource                  │
│  ├─ preloadedFeatureCodes from useLayerData ref                 │
│  └─ featureCodes prop     from layer config (checkbox state)    │
│       → filterPreloadedBatch (worker when enabled)              │
└─────────────────────────────────────────────────────────────────┘
```

Morton-tiled elements (`transcripts_morton`, etc.) use viewport tiles +
`featureCodes` in `loadPointsInBounds` per tile — no full-table preload.

Feature-primary or compound-indexed stores are still experimental. They may make
filter changes part of the structural load key because the point of the index is
to fetch only selected features.

---

## What we changed (summary)

### Vis (`@spatialdata/vis`)

- **`pointsPreloadCacheKey`** — for the current preloaded scatter path, memory
  cap only; no `featureCodes` in key.
- **`loadPoints`** — no longer passes `featureCodes`; filter does not reload
  geometry on this path.
- **`loadRowFeatureCodes`** — separate effect after preload; keyed by
  `preloadCacheKey`; passed to `PointsLayer` as `preloadedFeatureCodes`.
- **Catalog cache** — retry when cached value is `null` (failed load), not when
  a valid catalog exists.
- Removed filter-reload machinery (`beginPointsFilterReload`,
  `resolveRenderablePointsPreload`, etc.).

### Core (`@spatialdata/core`)

- **`loadPoints`** — ignores `featureCodes` unless
  `fullDatasetFeatureScan: true` (opt-in benchmark path, not used by vis).
- **`loadParquetTableCapped`** — prefers **row-group range reads** +
  column projection when store supports `getRange`.
- **`listPointsFeatures`** (large datasets) — feature-column scan with
  `readParquet` fallback when row-group decode is broken for dictionary columns.
- **Dictionary catalog helpers** — safe index extraction, merge across chunks,
  `featureCatalogNeedsParquetFallback` (empty or all-blank names).

### Layers (`@spatialdata/layers`)

- **`PointsLayer`** — async filtered-batch cache in `updateState`; filter
  signature includes `featureCodes`, `preloadedFeatureCodes`, `renderCap`.

---

## Workers: what they do today

The points worker is **enabled in the vis demo** via
`packages/vis/demo/src/enableDemoPointsWorker.ts`.

| Operation | Worker? | Notes |
|-----------|---------|-------|
| Feature filter on preloaded batch | **Yes** | `filterColumnarByFeatureCodesInWorker` in `PointsLayer` |
| Geometry preload (`loadPoints`) | **No** | Main thread; `loadParquetTableCapped` |
| Row feature codes (`loadRowFeatureCodes`) | **No** | Main thread; feature columns via capped table load |
| Feature catalog (large, dict-only) | **No** | Main thread; **full `loadParquetTable`** fallback |
| Feature counts | **Sometimes** | Only exposed when an explicit feature-code column validates code/name mapping |
| Opt-in full-dataset filter scan | **Yes** | `fullDatasetFeatureScan: true` + `loadPointsMatchingFeatureCodes` |

**Takeaway:** workers are used for **in-memory filter** after preload, not for
the heavy parquet paths that still dominate startup and catalog time. This is an
inconsistency worth cleaning up.

---

## Parquet I/O paths

### Good (row-group + projection)

- Morton viewport tiles: `loadParquetRowGroupByGroupIndex` + `store.getRange`.
- Geometry preload: `loadParquetTableCapped` → `_loadParquetTableRowGroupsCapped`
  when range reads work.
- Catalog on **`transcripts_morton`** (has `feature_name_codes`): row-group
  scan of feature columns only — fast (~hundreds of genes).

### Bad / fallback (full-file or full-column decode)

- **`loadParquetFileBytesAtPath`** still used in capped multipart fallback and
  opt-in `loadPointsMatchingFeatureCodes` / `loadFeatureCounts` worker paths.
- **Catalog on plain `transcripts`**: row-group reads do not decode
  dictionary-encoded `feature_name` correctly (empty names, single bogus
  entry). Fallback is **`loadParquetTable(parquetPath, [feature_name])` over all
  parts** — correct gene list, **~30s main-thread block** on 12M rows.

### Debug evidence (Xenium)

| Path | Catalog result | Mechanism |
|------|----------------|-----------|
| `transcripts` | ~30s, works after fallback | Dict-only; full feature-column read |
| `transcripts_morton` | Fast, ~541 genes | `feature_name_codes` + row-group scan |
| Row-group dict merge | 0 entries | `rowGroupsWithDictionary: 0` |
| Row-group scan (dict-only) | 1 blank entry | Indices without dictionary array |
| `RangeError: offset is out of bounds` | Catalog null | Fixed via safe `getDictionaryIndexAt` |

---

## Feature catalog bug timeline (why it was confusing)

1. Large datasets only built catalog from dictionary if a **1-row capped probe**
   worked → Arrow slice drops dictionary values → `null` catalog.
2. Feature-column row-group scan for dict-only columns → **one entry, empty
   name** (collapsed `nameToCode` map).
3. Dictionary row-group merge → **0 entries** (WASM row-group read not
   dictionary-typed the way we expected).
4. **Working fix:** skip row-group scan when no `feature_name_codes`; if catalog
   empty or all names blank → **`readParquet` full feature-column load**.

This fixed the UI but introduced the main-thread stall.

---

## Mental model: which path am I on?

```
transcripts (12M, dictionary feature_name, NO feature_name_codes)
  ├─ preload:     row-group x/y (capped 4M)           main thread, moderate
  ├─ row codes:   feature cols via loadParquetTableCapped  main thread, moderate
  ├─ catalog:     FULL readParquet [feature_name]      main thread, ~30s  ← pain point
  ├─ counts:      hidden until an explicit code/name mapping is available
  └─ filter toggle: worker in-memory on preloaded batch   fast, but capped

transcripts_morton (feature_name_codes + morton_code_2d)
  ├─ render:      Morton TileLayer, viewport-bounded
  ├─ catalog:     row-group feature columns             fast
  └─ filter:      per-tile featureCodes in getTileData

future feature-primary / compound-indexed store
  ├─ render:      query selected features, possibly viewport-bounded
  ├─ filter:      changes load key and fetches new rows
  └─ goal:        avoid loading thousands of genes when viewing a few
```

---

## Current status

### Working

- Feature filter toggles are **instant** on the current preloaded scatter path
  (no parquet rescan).
- Geometry preload uses row-group reads where the store supports them.
- Morton / coded elements get a reasonable catalog quickly.
- Plain `transcripts` catalog **populates** (after expensive fallback).
- Caps: memory cap (preload), render cap (draw), separate concerns.
- Tests: core 106, vis 65 (as of 2026-06-20).

### Not ideal / known debt

1. **Catalog for dict-only large datasets** — full-table feature-column read;
   blocks main thread ~30s; not justified long-term.
2. **Worker policy inconsistent** — filter off-thread; preload/catalog on-thread.
3. **`loadFeatureCounts`** — counts are hidden unless code/name mapping is
   explicit. Wrong counts are worse than missing counts.
4. **Strategy selection is unresolved** — preloaded in-memory filtering is one
   useful path, but feature-primary or compound-indexed stores may intentionally
   reload data when filters change.
5. **Legacy / dead-ish paths** — `loadPointsMatchingFeatureCodes`,
   `decodeParquetPartsInWorker`, `fullDatasetFeatureScan` (opt-in, no UI).
6. **Row-group WASM + dictionary columns** — broken for catalog; we paper over
   with full read; root cause not fixed in the reader layer.

---

## Cleanup plan (prioritized)

### P0 — Remove the 30s catalog stall (plain `transcripts`)

Pick one or combine:

| Approach | Effort | Notes |
|----------|--------|-------|
| **Dictionary from parquet metadata** | Medium | Read dictionary pages / schema without scanning 12M rows; ideal for Xenium |
| **Worker-backed catalog build** | Low–medium | Same bytes as today, off main thread; doesn't reduce total work |
| **Cache catalog per element** | Low | IndexedDB or in-memory; first visit still slow |
| **Writer: always emit `feature_name_codes`** | Medium | Aligns with morton path; Python writer change |
| **Sidecar gene list** | Low | Small JSON/parquet in element attrs (non-standard) |

**Recommendation:** metadata/dictionary-page fast path first; worker offload as
a quick win if metadata path is hard in parquet-wasm.

### P1 — Unify worker policy

Document and implement one rule, e.g.:

> All parquet decode and row scans run in the points worker; main thread only
> marshals Arrow IPC and deck props.

Or explicitly drop worker for decode and accept main-thread decode with
chunking/`requestIdleCallback` — but be consistent.

### P2 — Defer non-critical work

- Show catalog from dictionary-only fast path **without counts** first.
- Load `loadFeatureCounts` only when user opens filter panel or on idle.
- Don't block first render on catalog (already partially true).

### P3 — Trim legacy paths

- Remove or gate `fullDatasetFeatureScan` unless needed for benchmarks.
- Audit `loadPointsMatchingFeatureCodes` vs runtime filter. The answer may be
  different per strategy: preloaded scatter filters in memory, while
  feature-indexed stores may use source-side feature queries.
- Remove unused worker decode entry points if nothing calls them.

### P4 — Fix row-group dictionary decode (proper parquet)

- Investigate parquet-wasm `readParquetRowGroup` + column projection for
  dictionary columns on Xenium multipart layout.
- Goal: row-group catalog path works for dict-only `feature_name` without full
  table read.

### Future note — DuckDB / DuckDB-Wasm

DuckDB is not part of the current render path. It may become useful later as a
correctness oracle for Parquet scans, an offline writer/benchmark validation
tool, or a worker-backed catalog/count query engine. Do not add it to browser
tile loading without a separate benchmark and bundle-size decision.

---

## API contracts (for reference)

### Vis preload cache key for preloaded scatter

```
{elementKey}|m{memoryCap}
```

Feature filter is **not** part of this key for the current preloaded scatter
path. A future feature-primary or compound-indexed strategy may include selected
features in its structural load key.

### `featureCodes` semantics

| Value | Meaning |
|-------|---------|
| `undefined` | All features |
| `[]` | No features |
| `[1, 2, 3]` | Subset |

### Large-dataset catalog strategy (`listPointsFeatures`)

1. If `feature_name_codes` (or `{feature_key}_codes`) present → row-group scan
   of feature columns.
2. Else if catalog empty or all blank names after row groups →
   `loadParquetTable` feature columns only (current fallback).
3. Small datasets → full `loadParquetTable` with feature columns (unchanged).

---

## Files touched (main areas)

| Area | Files |
|------|-------|
| Core load/filter | `packages/core/src/models/VPointsSource.ts`, `VTableSource.ts` |
| Feature catalog | `packages/core/src/pointsFeatures.ts` |
| Worker | `packages/core/src/workers/points-worker.ts`, `pointsWorkerClient.ts` |
| Vis preload/filter | `packages/vis/src/SpatialCanvas/useLayerData.ts`, `pointsLoadPlan.ts` |
| Layer filter cache | `packages/layers/src/PointsLayer.ts` |
| UI | `packages/vis/src/SpatialCanvas/PointsFeatureFilterPanel.tsx` |

---

## Open questions

1. Is a one-time 30s catalog acceptable if cached for the session, or must
   first open be sub-second?
2. Should we require Morton + `feature_name_codes` for large transcript datasets
   in production, treating plain `transcripts` as legacy?
3. Should catalog/counts move entirely to the worker before further vis work?
4. What metadata should writers emit so the resolver can distinguish spatial
   Morton, feature-primary, and compound spatial+feature indexes?
5. When should feature filter changes reload source data instead of filtering a
   preloaded batch?

---

## Changelog (this effort)

- Runtime feature filter on preloaded scatter (no geometry reload on toggle).
- Row-group capped reads for geometry preload.
- Feature catalog fixes for dictionary-encoded large datasets (fallback read).
- Safe dictionary index extraction; catalog retry on `null` cache.
- Removed debug instrumentation (2026-06-20).
