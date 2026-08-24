---
"@spatialdata/core": minor
"@spatialdata/layers": patch
"@spatialdata/vis": minor
---

Points: render Morton-indexed elements from viewport tiles, on by default.

A points element backed by a Morton-ordered Parquet artifact now draws through deck's
`TileLayer`, reading row groups for the viewport, instead of a memory-capped resident
preload. A 12.1M-point Xenium `transcripts` element can be explored at full detail, and
the resident memory cap no longer applies to it. Tiles colour by feature, honour the
feature filter inside the row-group scan, and subdivide with zoom.

`pointsTiling` defaults to `'auto'`, so every points element is probed once and takes the
tiled path if — and only if — it can. Read the config through `pointsTilingEnabled(...)`
rather than comparing to `'auto'`: the default has to mean the same thing to the resolver
deciding what to load, the hook deciding what to render, and the panel drawing the
checkbox. `pointsTiling: 'off'` restores the previous behaviour per layer.

**Why on rather than opt-in.** On a Morton artifact the capped preload is not a neutral
alternative: it keeps the first `cap` rows in FILE order, and file order there is a prefix
of the Z-curve — a spatially skewed chunk of the slide rather than a sample of it.

**What it costs, measured.** At the default zoomed-out framing of that 12.1M-point
element the tiled path loads all 44 tiles — 12,165,029 points / ~158 MB, the whole
artifact — against a 4M-row prefix for the preload. First paint on a fully zoomed-out
view is ~3x the rows, in exchange for a correct picture that streams in 44 pieces instead
of blocking on one decode. Zooming OUT is the one direction viewport tiling does not
help, because there is no coarser representation to read; that wants a multi-resolution
points pyramid, not a finer index. An element that cannot be tiled is unaffected beyond
one probe (4 range reads / ~2.16 MB), cached with its metadata.

Applying a feature filter does **not** reduce I/O, and the plan's original expectation
that it would has been corrected: row groups are chosen *spatially*, and a gene's points
are spread across all of them. It cuts what is uploaded and drawn — one gene takes a
viewport tile from 3,128,988 points to 87,594 — not what is read. Narrowing the fetch by
feature needs a feature-primary index (the open question in ADR 0002/0003).

**The tile grid is derived from the artifact.** It was one fixed level
(`minZoom`/`maxZoom: -1`), so every tile was 1024 local units at every zoom, and 1024 came
from deck's defaults rather than from the data. `mortonTileGrid` now derives both ends
from point density: the finest level stays at least one row group's footprint, the
coarsest holds at most 400k rows, and `zoomOffset = log2(modelMatrixScale)` couples deck's
`z` to tile spans expressed in local units. `maxCacheSize` comes from a row budget rather
than deck's `5 x the selected tile count`, which on a coarse viewport of this element
could retain ~220 tiles / ~71M rows against a 4M resident cap. Accounting only — nothing
evicts by bytes yet (ADR 0005). `PointsLoaderCapabilities` gains `totalRows` and
`maxRowsPerGroup`, which the grid is derived from, and `mortonTileGrid` applies its
documented default (the resident points memory cap) when no `cacheRowBudget` is given.

Tiling is per LAYER but the probe's answer is cached per ELEMENT, so every consumer
combines the two (`usesTiledPath`, `isTiledFor`). Reading the probe alone left a layer
rendering tiles after the user switched tiling off, while planning went back to
preloading — both at once.

Per package:

- **`@spatialdata/core`** — `PointsResolver` gains a `tiling` resource (a one-key
  `RequestSlot` holding the element's tileable Morton metadata, or `null` when it cannot
  drive tiles) and reports what a tiled entry actually has: no `preload` resource (absent,
  not idle, so `isBlocking` skips it), world `bounds` from the artifact's own extent so
  auto-fit can frame the layer before a tile loads, geometry status driven by the probe.
  `blockingResources` covers `tiling` as well as `preload`. `scanMortonTableInBounds`
  appends a feature code per point in lockstep with the geometry, and
  `loadMortonPointsInBounds` projects the code column whenever the artifact **has** one
  rather than only when a filter is active — the no-filter "all features" view was
  precisely the case that arrived without codes. `planPointsLoads` moves here from
  `@spatialdata/layers` (re-exported there; no consumer import moves), and
  `transformAxisAlignedBounds` is new.
`PointsDataEngine.ensureTilingMetadata` is idempotent once the probe has settled: a ready
`RequestSlot` answers with a fresh resolved promise, so a repeat call would otherwise churn
the layer's status loading→ready and re-run the resident release. A *failed* probe stays
retryable.

- **`@spatialdata/layers`** — `mortonTiledStrategy`, and
  `PointsRendererAdapter.getTiledResource` memoised on (element, metadata): a new resource
  identity would make `TileLayer` refetch every visible tile, so a pan would become a full
  reload.
- **`@spatialdata/vis`** — the tiled branch in `getLayers`, tiled world bounds,
  `hasRenderableLayerData` counting a tiled element as drawable, viewport-tile progress
  feeding `isLoading`, and `pointsTiling` / `showTileDebugOverlay` panel controls.

Three things a tiled layer got wrong once it was actually drawing, also fixed here. The
resident window is now released when the probe settles — `plan()` stops *asking* for a
preload, which is not the same as evicting one — along with its row-aligned codes and
feature-index scan, though the catalog stays, since it describes the element rather than
the window. The panel's truncation notice no longer reads "4,000,000 of 12,165,021 points
in memory — capped" directly above "the memory cap does not apply"; it says nothing, and
the memory-cap control is hidden. And point sizing is one behaviour instead of two: the
tile path sized in fixed pixels while the preloaded path used world units, so a zoomed-out
tiled layer drew every one of its millions of points as a fixed screen dot, saturating
density into a flat mass and hardening every tile seam into what looked like a rendering
fault. Both paths now size in world units with the model-matrix scale folded in.

A short feature-codes array is dropped rather than padded, on both paths: the remaining
points would read code 0 — a *valid* feature — and be confidently mis-coloured, which is
worse than no colour at all.
