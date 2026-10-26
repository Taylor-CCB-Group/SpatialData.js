---
"@spatialdata/core": patch
"@spatialdata/layers": patch
---

Experimental: a points element with a copy in merfisheyes' draft multiscale points-zarr layout (as its `experimental.points-zarr` subgroup, beside `points.parquet`) is drawn as level-of-detail tiles read from the copy; stores in merfisheyes' own layout open too. `getPointsTilingMetadata()` and `PointsResolver.getTilingMetadata()` now return `AnyPointsTilingMetadata`, so narrow on `kind === 'morton-points'` before reading Morton fields; `PointsTilingMetadata` itself is unchanged.
