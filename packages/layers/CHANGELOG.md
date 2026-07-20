# @spatialdata/layers

## 0.3.0

### Minor Changes

- [#88](https://github.com/Taylor-CCB-Group/SpatialData.js/pull/88) [`6e153a6`](https://github.com/Taylor-CCB-Group/SpatialData.js/commit/6e153a6e3e7e564d31b835828615d8145b6bc805) Thanks [@xinaesthete](https://github.com/xinaesthete)! - Non-blocking shapes loading + a vertex-pulling `FlatPolygonLayer`.

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

### Patch Changes

- [#71](https://github.com/Taylor-CCB-Group/SpatialData.js/pull/71) [`bd594e2`](https://github.com/Taylor-CCB-Group/SpatialData.js/commit/bd594e2e1efddffb4b9280d0970abd0aa84fed0e) Thanks [@xinaesthete](https://github.com/xinaesthete)! - Fix multiscale labels rendering with an obviously wrong (vertically stretched, mis-placed) transformation when zoomed out past the coarsest resolution level.

  The `MultiscaleLabelsTileLayer` was configured with `minZoom: -20`, so deck.gl kept subdividing the tile grid below the deepest available resolution level. Past that level `getTileData` clamps to the deepest loader and returns the same data, but the tile bbox keeps doubling — so the bounds formula stretched that fixed data across an ever-larger world rect, far beyond the image extent. `minZoom` is now capped at `-(loader.length - 1)`, matching Viv's `MultiscaleImageLayer`, so the coarsest real tiles stay correctly placed at any zoom-out.

  Also adds the bbox-culling guards Viv's `renderSubLayers` applies (skip tiles with negative bbox edges or zero-sized data) for defense in depth. This is the underlying cause that [#44](https://github.com/Taylor-CCB-Group/SpatialData.js/issues/44) only masked by making sublayer ids unique.

- [#80](https://github.com/Taylor-CCB-Group/SpatialData.js/pull/80) [`ab1b809`](https://github.com/Taylor-CCB-Group/SpatialData.js/commit/ab1b80989b66e27950f74b503c91348b90b60827) Thanks [@xinaesthete](https://github.com/xinaesthete)! - Points/transcript rendering: composite layer, loading engine, and size controls.

  Points elements render through the `@spatialdata/layers` `PointsLayer` composite
  (ADR 0003) via a store-agnostic `resolvePointsRenderResource` boundary, backed by
  a new React-free `PointsDataEngine` that owns points loading, caching, and
  render-resource resolution. `@spatialdata/core` gains the points I/O foundation
  (bounded/capped loading, Morton tiling metadata, feature catalog, an opt-in
  worker, and vendored parquet-wasm with row-group range reads). SpatialCanvas adds
  a point-size control; preloaded points are sized in world units so they scale
  with zoom, clamped to a pixel range.

- [#79](https://github.com/Taylor-CCB-Group/SpatialData.js/pull/79) [`8607083`](https://github.com/Taylor-CCB-Group/SpatialData.js/commit/86070837958ffb5761d004446b5a23a8520d6c79) Thanks [@xinaesthete](https://github.com/xinaesthete)! - SpatialCanvas hover/picking performance and Rules-of-React cleanup.

  Picking/tooltip performance:

  - New `hoverTooltipMode` prop (`'off' | 'simple' | 'aggregate'`, default
    `'aggregate'`) on `SpatialCanvas` and `SpatialCanvasViewer`, with a matching
    selector in the `SpatialCanvas` UI. `'aggregate'` reports every feature under
    the cursor across layers (`pickMultipleObjects` GPU passes); `'simple'`
    resolves the single top-most pick deck.gl already does for hover/highlight;
    `'off'` makes shape layers non-pickable entirely (no autoHighlight, no
    picking-buffer render) — the cheapest mode. Replaces the earlier boolean
    `aggregateHoverTooltips`.
  - Picking stays live through pan/zoom. The shapes layer keeps a `pickingEnabled`
    option (`@spatialdata/layers`) that `'off'` mode uses to drop picking, but it
    is no longer toggled by camera gestures — the `FlatPolygonLayer` pick pass is a
    single cheap vertex-pulled draw, so no gesture gate is needed.
  - Hover tooltip resolution is suppressed while a pointer button is held (drag),
    and the per-missing-layer supplemental aggregation pick is collapsed into a
    single batched pick. The hover-tooltip machinery (pick → tooltip → portal) is a
    single `useHoverFeatureTooltip` hook shared by both canvas surfaces.

  Rules-of-React fixes (eslint-plugin-react-hooks, `pnpm lint:react` now clean and
  the `react-lint` CI job is required): removed ref reads/writes during render and
  replaced setState-in-effect patterns with derived state in `@spatialdata/react`
  `useSpatialData` and the vis `Transforms`, `Table`, `Shapes`, `ImageView`, and
  `SpatialCanvas` components.

- Updated dependencies [[`ab1b809`](https://github.com/Taylor-CCB-Group/SpatialData.js/commit/ab1b80989b66e27950f74b503c91348b90b60827), [`6e153a6`](https://github.com/Taylor-CCB-Group/SpatialData.js/commit/6e153a6e3e7e564d31b835828615d8145b6bc805)]:
  - @spatialdata/core@0.3.0

## 0.2.5

## 0.2.4

## 0.2.3

## 0.2.2

## 0.2.1

## 0.2.0

### Minor Changes

- [#49](https://github.com/Taylor-CCB-Group/SpatialData.js/pull/49) [`7c7fdf6`](https://github.com/Taylor-CCB-Group/SpatialData.js/commit/7c7fdf6d86c726381c1eb9e44dd05a2fe08a8fea) Thanks [@xinaesthete](https://github.com/xinaesthete)! - Add the render stack contract for ordered SpatialData and host-layer rendering, with React viewer adapters for resolving stack entries into Viv/deck output.

  Expose richer SpatialCanvas feature-pick events for labels and shapes, including `elementKind`, `spatialElement`, tooltip metadata, and runtime SpatialData context.

### Patch Changes

- [#44](https://github.com/Taylor-CCB-Group/SpatialData.js/pull/44) [`2e74bea`](https://github.com/Taylor-CCB-Group/SpatialData.js/commit/2e74beaf44598debe9692f6da38b6584c4c04fa5) Thanks [@xinaesthete](https://github.com/xinaesthete)! - Fix intermittent labels layer transform glitches when multiple multiscale labels layers are rendered together by making generated bitmask tile layer ids unique per tile resolution.

## 0.1.0

### Minor Changes

- [#42](https://github.com/Taylor-CCB-Group/SpatialData.js/pull/42) [`0a73939`](https://github.com/Taylor-CCB-Group/SpatialData.js/commit/0a73939691b44b44204842e3d408a8d1114c2212) Thanks [@xinaesthete](https://github.com/xinaesthete)! - Prepare the first MDV-targeted alpha prerelease.

## 0.1.0-next.0

### Minor Changes

- [#42](https://github.com/Taylor-CCB-Group/SpatialData.js/pull/42) [`0a73939`](https://github.com/Taylor-CCB-Group/SpatialData.js/commit/0a73939691b44b44204842e3d408a8d1114c2212) Thanks [@xinaesthete](https://github.com/xinaesthete)! - Prepare the first MDV-targeted alpha prerelease.
