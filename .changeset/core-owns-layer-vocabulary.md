---
'@spatialdata/core': minor
'@spatialdata/layers': patch
---

`@spatialdata/core` now exports `ShapeStrokeWidthUnits` and the
`SHAPE_STROKE_WIDTH_UNITS` tuple that `spatialLayerPropsSchema` derives its
`defaultStrokeWidthUnits` enum from, so the schema and the type cannot drift.

Nothing changes for existing callers: `@spatialdata/layers` re-exports the type
under its own name, and its `FeatureColumnKind` is now an alias of core's
`TableColumnKind` rather than a second copy of it.
