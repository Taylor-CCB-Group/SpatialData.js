---
"@spatialdata/core": patch
"@spatialdata/layers": patch
"@spatialdata/vis": patch
---

Points: render Morton-tiled elements from viewport tiles (D5 step 2).

A points layer with `pointsTiling: 'auto'` on a Morton artifact now draws through
`mortonTiledStrategy` — deck's `TileLayer` reading row groups for the viewport —
instead of a memory-capped resident preload. A 12.1M-point transcripts element can be
explored at full detail, and the memory cap no longer applies to it.

- **`@spatialdata/core`** — `PointsResolver` reports what a tiled entry actually has:
  no `preload` resource (absent, not idle, so `isBlocking` skips it), world `bounds`
  derived from the artifact's own extent so auto-fit can frame the layer before a
  single tile loads, and geometry status driven by the probe. `blockingResources`
  covers `tiling` as well as `preload`. New `transformAxisAlignedBounds` helper.
- **`@spatialdata/layers`** — `PointsRendererAdapter.getTiledResource`, memoised on
  (element, metadata): a new resource identity would make `TileLayer` refetch every
  visible tile, so a pan would become a full reload. Exposed via `PointsDataEngine`
  alongside `isTiled` / `getTilingMetadata` / `ensureTilingMetadata`.
- **`@spatialdata/vis`** — the tiled branch in `getLayers`, tiled world bounds,
  `hasRenderableLayerData` counting a tiled element as drawable, per-layer tile-debug
  stores feeding viewport-tile progress into `isLoading`, and `pointsTiling` /
  `showTileDebugOverlay` controls on the points layer panel.

Tiling is per LAYER but the probe's answer is cached per ELEMENT, so every consumer
combines the two (`usesTiledPath`, `isTiledFor`). Reading the probe alone left a layer
rendering tiles after the user switched tiling off, while planning went back to
preloading — both at once.

Known gaps, tracked in `docs/plans/points-morton-tiled-viewport-loading.md`: a tiled
layer draws flat-coloured and ignores the feature filter (the tile scan does not yet
return per-point codes — step 3), switching a layer to tiling does not evict the
preload it already did, and the panel's truncation notice still reports resident
memory on a tiled layer.
