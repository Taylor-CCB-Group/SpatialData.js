---
"@spatialdata/core": patch
"@spatialdata/layers": patch
"@spatialdata/vis": patch
---

Points: colour a Morton-tiled layer by feature (D5 step 3).

Viewport tiles now carry a feature code per point, so a tiled layer colours, takes
per-feature overrides and responds to Feature Highlight exactly like the preloaded
path. Until now it drew flat — the same element looked like two different datasets
depending on a checkbox.

The codes were already being read and thrown away: the tile scan consults the feature
column to filter on it, then returned bare coordinates.

- **`@spatialdata/core`** — `scanMortonTableInBounds` takes an optional
  `Int32PointBuffer` and appends to it in lockstep with the geometry; the worker's
  tile-scan handler builds one and returns it (the protocol already carried an
  optional `featureCodes` and transferred its buffer, so the worker boundary needed no
  change). `loadMortonPointsInBounds` now projects the code column whenever the
  artifact **has** one rather than only when a filter is active — the no-filter "all
  features" view was precisely the case that arrived without codes — and both its
  worker and main-thread returns carry them.
- **`@spatialdata/layers`** — `mortonTiledStrategy` forwards `colorByFeature`,
  `featureCodeSpaceSize`, `featureColorOverrides` and `highlightFeatureCode` to its
  per-tile scatter layers, and rebuilds them when those change.
- **`@spatialdata/vis`** — the tiled branch stops forcing `colorByFeature: false` and
  reads the same element-scoped colour inputs the preloaded branch does.

A short codes array is dropped rather than padded, on both paths: the remaining points
would read code 0 — a *valid* feature — and be confidently mis-coloured, which is
worse than no colour at all.

The feature **filter** still does not narrow tiles (step 4): a tiled layer draws every
feature in the viewport regardless of the selection, and the panel now says so.
