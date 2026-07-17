---
"@spatialdata/core": minor
"@spatialdata/layers": minor
"@spatialdata/vis": minor
---

Non-blocking shapes loading + a vertex-pulling `FlatPolygonLayer`.

Shapes no longer gate first paint. The geometry column is decoded (WKB → flat buffers)
**and tessellated** into render topology inside the geometry worker and transferred back
zero-copy; `ShapesResolver.blockingResources` is now `[]`, and a main-thread tessellation
fallback covers the no-worker path. This removes the full-element main-thread WKB decode
that previously blocked behind the "Loading layer data…" overlay, and it lets Visium HD
`square_002um` (~2.7M polygons) load without running out of memory.

Polygon shapes now render through a new hand-rolled `FlatPolygonLayer`
(`@spatialdata/layers`) instead of deck's `SolidPolygonLayer` + a `PathLayer` outline:

- **Vertex pulling** — an attribute-less draw where the vertex shader reconstructs each
  vertex's position and a boundary edge-distance from two shared geometry textures via
  `gl_VertexID`, and imputes an anti-aliased outline with `fwidth` in the fragment shader
  (no separate outline layer). Per-frame cost ≈ the fill; geometry memory ≈ the stock
  indexed fill. Works on arbitrary polygons (cell segmentation, not just grids).
- **Feature state via a per-feature colour texture** (the reusable "table column →
  buffer" primitive): colour-by-column, hide, and fade re-upload only a small texture,
  never the geometry buffers. Picking colours are computed in-shader from the feature
  index.
- **Outline** is a lightened derivation of the fill, width-capped to a fraction of each
  shape's on-screen size and faded out for sub-pixel shapes — clear when zoomed in,
  non-dominating (no moiré) when zoomed out.

New/changed public surface: `@spatialdata/core` exports `tessellateFlatPolygons` /
`TessellatedPolygons` and carries the tessellated topology on `ShapesRenderData`;
`@spatialdata/layers` exports `FlatPolygonLayer`. `@spatialdata/vis` decouples the
one-shot auto-fit from the shapes-blocking transition so a shapes-only view still frames
correctly.

Also fixes a fill-colour "one column behind" bug (the feature-state runtime cache is now
keyed on the fill-colour entry identity, not just its column signature); the hover/pan
buffer-thrash from unstable deck `updateTrigger` arrays; and a per-feature colour-buffer
thrash where two shapes layers sharing the default feature-state runtime rebuilt each
other's (million-element) colour buffer on every frame — the `FlatPolygonLayer` colour
cache is now keyed per layer.

Known follow-ups: the main-thread GPU texture upload (~seconds on the largest elements)
is not yet off the main thread — a WGSL/WebGPU variant (storage buffers instead of
texture-packing) is the intended fix; explicit per-feature stroke override on the polygon
path; non-blocking associated-table load.
