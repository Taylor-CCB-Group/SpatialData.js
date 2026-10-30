---
"@spatialdata/layers": minor
---

New `ShapesRendererAdapter` and `LabelsRendererAdapter`. Hand either one a resolved element's data plus a layer's props, and `render()` returns the deck layers — the identity-stable projections in between (prebuilt feature arrays, table-column fill colours, the per-label colour LUT) are held for you, so a repeated render does not rebuild GPU attributes. A `@spatialdata/vis` layer config satisfies the props they read, so it passes straight through.
