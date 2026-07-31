---
'@spatialdata/layers': minor
'@spatialdata/vis': minor
---

Let a host hand in precomputed feature colours as a buffer, for shapes and labels.

`SpatialCanvasViewer` takes a `featureColorResolver` — a runtime attachment alongside
`hostLayerResolver` / `vivImagePropsResolver` — returning a `FeatureColorBuffer`
(`{ colors: Uint8Array; count: number }`) for a layer. Use it when colour comes from data
a config cannot carry: a computed column, an annotation from outside the table, a live
selection.

Previously the only route was `featureState.fillColorByFeatureId`, which makes the host
stringify integers it already had and costs a Map copy plus (for labels) a parse per
entry, all to produce the buffer the renderer wanted anyway.

The index means different things per kind, and the resolver context says which: for labels
it is the raster's own pixel value; for shapes it is the position in the loaded geometry,
so the context supplies the `featureIds` ordering to build against. A buffer wins over
`featureState` rather than merging with it — bake hide and fade into the alpha.

Also: `LabelColorLut` is now `FeatureColorBuffer` (`labelCount` → `count`) so both kinds
share one currency.
