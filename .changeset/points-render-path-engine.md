---
"@spatialdata/core": patch
"@spatialdata/layers": patch
"@spatialdata/vis": patch
---

Points/transcript rendering: composite layer, loading engine, and size controls.

Points elements render through the `@spatialdata/layers` `PointsLayer` composite
(ADR 0003) via a store-agnostic `resolvePointsRenderResource` boundary, backed by
a new React-free `PointsDataEngine` that owns points loading, caching, and
render-resource resolution. `@spatialdata/core` gains the points I/O foundation
(bounded/capped loading, Morton tiling metadata, feature catalog, an opt-in
worker, and vendored parquet-wasm with row-group range reads). SpatialCanvas adds
a point-size control; preloaded points are sized in world units so they scale
with zoom, clamped to a pixel range.
