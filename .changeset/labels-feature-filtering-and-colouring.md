---
'@spatialdata/layers': minor
'@spatialdata/vis': minor
---

Filter and colour annotated labels elements with the same API as shapes.

A labels layer now accepts `fillColorByColumn` (colour every label by an obs column of
its associated table) and a `featureState` with the same fields and meanings a shapes
layer's takes — `fillColorByFeatureId`, `hiddenFeatureIds`, `fadedFeatureIds`,
`filteredOpacityMultiplier` — keyed by the label's integer instance id as a string.

The mechanism mirrors shapes: the palette, numeric ramp and `'auto'` mode detection are
now shared (`featureColorEncoding`), so the same column reads the same way on a shapes
layer and on a labels layer over the same table. Where a shape resolves its colour from a
per-feature texture indexed by feature index, a label resolves its colour from a
per-label lookup table indexed by the raster's own pixel value, sampled in the bitmask
fragment shader. Hidden labels are discarded, faded labels scale the channel's fill and
outline opacities, and a hidden label is no longer pickable. The lookup table is owned by
`LabelsLayer` and shared across tile sublayers, and is re-uploaded only when the
feature-state it encodes actually changes.
