---
"@spatialdata/core": patch
"@spatialdata/layers": patch
"@spatialdata/vis": patch
---

Points/transcript rendering pipeline: composite layer, loading engine, and size controls.

Points elements now render through the `@spatialdata/layers` `PointsLayer`
composite (ADR 0003) instead of the flat inline scatter renderer, reached via a
store-agnostic `resolvePointsRenderResource` boundary.

- **`@spatialdata/core`** gains the points I/O foundation: bounded/capped
  loading on `PointsElement` (`loadPoints`, `loadPointsInBounds`,
  `listFeatures`, aligned row feature codes), Morton tiling metadata, a
  dictionary-aware feature catalog, and an **opt-in** points worker for
  off-thread parquet decode/scan. parquet-wasm is now vendored (replacing the
  npm/CDN dependency) and large reads use row-group range reads with column
  projection.
- **`@spatialdata/layers`** owns the render strategies (preloaded scatter,
  Morton-tiled, GeoArrow stubs), the `PointsLayer` composite, tile-debug
  overlay, and a new framework-agnostic **`PointsDataEngine`** that holds the
  points cache, the stable render-resource memo, and the async load
  orchestration (the first sub-engine of the LayerDataEngine decomposition —
  React-free and unit-tested).
- **`@spatialdata/vis`** renders points through the composite/engine and adds a
  **point size** control to the SpatialCanvas layer panel. Preloaded points are
  sized in world units so the GPU scales them with zoom (reducing scatter
  overdraw when zoomed out), clamped to a pixel range.

Fixes surfaced while wiring this up: forever-loading transcripts (the points
worker is now opt-in), a stale-disabled "Center on layer" button for
freshly-loaded layers, a per-frame layer flash while panning, and a deck.gl
sublayer id-collision assertion.

Not yet wired into the UI (present in `core`/`layers`, follow-up — see
`docs/plans/points-mvp-and-roadmap.md`): feature filtering, colour-by-feature,
per-point tooltips, and the Morton *tiled* render path (points currently load as
a capped preload).
