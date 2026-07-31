---
'@spatialdata/core': minor
'@spatialdata/layers': minor
---

Add `featureState` to the labels sublayer schema, and export `SpatialLabelsSublayer`.

`spatialLabelsSublayerSchema` now carries `fillColorByFeatureId`, `hiddenFeatureIds`,
`fadedFeatureIds` and `filteredOpacityMultiplier` — the same field names and meanings
`spatialShapesSublayerSchema` already had, keyed by the label's integer instance id as a
string. It omits `strokeColorByFeatureId`: a label's outline is derived from its fill in
the bitmask shader, so there is no per-label stroke to override.

This closes the last place where a labels layer could not express what a shapes layer
could.
