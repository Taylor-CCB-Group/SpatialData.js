---
"@spatialdata/layers": minor
---

`ShapesRendererAdapter` and `LabelsRendererAdapter` turn a resolved entry's resources plus its props into deck layers, holding the identity-stable projections in between — prebuilt feature arrays, the feature-state runtime, table-column fill colours, the per-label colour LUT. Both expose `render()`, and shapes also exposes `getRenderData` / `getPrebuilt` for callers that need the same geometry for picking. Each declares the entry props it reads structurally, so a `@spatialdata/vis` layer config satisfies it without the two packages depending on each other.

Nothing moved out of any package's public surface: this is additive, and `@spatialdata/vis` exports exactly what it did before.
