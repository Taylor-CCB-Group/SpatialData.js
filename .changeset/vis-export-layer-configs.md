---
'@spatialdata/vis': minor
---

Export the per-layer config types from the package root: `BaseLayerConfig`,
`ImageLayerConfig`, `ShapesLayerConfig`, `PointsLayerConfig`,
`LabelsLayerConfig`, plus `FeatureStateConfig`, `FillColorByColumn` and
`ViewState2D` / `ViewState3D`.

`LayerConfig` was already public but its members were not, so narrowing to one
layer kind meant `Extract<LayerConfig, { type: 'shapes' }>`.

Also re-exports the field types those configs are built from
(`ShapeFillColorMode`, `LabelFillColorMode`, `ShapeStrokeWidthUnits`,
`FeatureCategoricalPaletteSpec`, `FeatureNumericRampSpec`,
`FeatureMissingValueOptions`), so a caller can name a `fillColorByColumn` or
`strokeWidthUnits` value without depending on `@spatialdata/layers` directly.
