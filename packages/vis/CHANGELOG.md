# @spatialdata/vis

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

### Patch Changes

- [#68](https://github.com/Taylor-CCB-Group/SpatialData.js/pull/68) [`25124c5`](https://github.com/Taylor-CCB-Group/SpatialData.js/commit/25124c50a2107a1813c3bac1ee8d48161b477422) Thanks [@xinaesthete](https://github.com/xinaesthete)! - Bump viv to 0.22.0 and deck.gl/luma.gl ecosystem to 9.3.5

- [#86](https://github.com/Taylor-CCB-Group/SpatialData.js/pull/86) [`716bc44`](https://github.com/Taylor-CCB-Group/SpatialData.js/commit/716bc44fa8c13e6fcfb318064e07ea0f7b08de02) Thanks [@xinaesthete](https://github.com/xinaesthete)! - useLayerData consumes the Resource Resolvers via a single reconcile loop.

  `useLayerData` now drives layer loading through `@spatialdata/core`'s
  `SpatialEntryStore.reconcile()` over per-kind `ResourceResolver`s — `PointsResolver`
  / `ShapesResolver` from `core`, `ImagesResolver` / `LabelsResolver` from `vis` —
  instead of the previous per-kind `Promise.all` load switch. Shapes geometry/tooltip/
  fill-colour rows, image and labels channel defaults, and points preload are all read
  from their resolvers; points continue to run through the stable `PointsDataEngine`,
  which the store borrows via a non-owning proxy so a dataset swap does not dispose it.

  Purely an internal restructuring behind ADR 0004 (Step 1 consumption): the 17-member
  public surface is unchanged and guarded by `useLayerData.spec.tsx`.

- [#75](https://github.com/Taylor-CCB-Group/SpatialData.js/pull/75) [`f109b95`](https://github.com/Taylor-CCB-Group/SpatialData.js/commit/f109b95ab44a5255537c9dbd861cf2c92fee2283) Thanks [@xinaesthete](https://github.com/xinaesthete)! - Auto-select the coordinate system when a SpatialData object has exactly one. Previously the picker started unselected (showing "Select a coordinate system") even when there was only one choice, and a separate effect would eagerly pick the first of several. Now selection defaults only in the unambiguous single-coordinate-system case; multi-system datasets still require an explicit choice.

- [#80](https://github.com/Taylor-CCB-Group/SpatialData.js/pull/80) [`ab1b809`](https://github.com/Taylor-CCB-Group/SpatialData.js/commit/ab1b80989b66e27950f74b503c91348b90b60827) Thanks [@xinaesthete](https://github.com/xinaesthete)! - Points/transcript rendering: composite layer, loading engine, and size controls.

  Points elements render through the `@spatialdata/layers` `PointsLayer` composite
  (ADR 0003) via a store-agnostic `resolvePointsRenderResource` boundary, backed by
  a new React-free `PointsDataEngine` that owns points loading, caching, and
  render-resource resolution. `@spatialdata/core` gains the points I/O foundation
  (bounded/capped loading, Morton tiling metadata, feature catalog, an opt-in
  worker, and vendored parquet-wasm with row-group range reads). SpatialCanvas adds
  a point-size control; preloaded points are sized in world units so they scale
  with zoom, clamped to a pixel range.

- [#69](https://github.com/Taylor-CCB-Group/SpatialData.js/pull/69) [`e343a72`](https://github.com/Taylor-CCB-Group/SpatialData.js/commit/e343a721ce949fd9592c8ead2edec9a238f70f92) Thanks [@xinaesthete](https://github.com/xinaesthete)! - Switch HTJ2K codec from `@cornerstonejs/codec-openjph` to `openjph-wasm`, which correctly round-trips multi-component (volumetric) HTJ2K data. The cornerstone build silently dropped components 2..N on decode; `openjph-wasm` handles arbitrary component counts losslessly.

  Also adds true z>1 multi-component chunk support: z-planes are now encoded as components of a single codestream rather than one plane per chunk. Exports `Htj2kPlane` from the package index.

- Updated dependencies [[`bd594e2`](https://github.com/Taylor-CCB-Group/SpatialData.js/commit/bd594e2e1efddffb4b9280d0970abd0aa84fed0e), [`ab1b809`](https://github.com/Taylor-CCB-Group/SpatialData.js/commit/ab1b80989b66e27950f74b503c91348b90b60827), [`6e153a6`](https://github.com/Taylor-CCB-Group/SpatialData.js/commit/6e153a6e3e7e564d31b835828615d8145b6bc805), [`8607083`](https://github.com/Taylor-CCB-Group/SpatialData.js/commit/86070837958ffb5761d004446b5a23a8520d6c79), [`e343a72`](https://github.com/Taylor-CCB-Group/SpatialData.js/commit/e343a721ce949fd9592c8ead2edec9a238f70f92)]:
  - @spatialdata/layers@0.3.0
  - @spatialdata/core@0.3.0
  - @spatialdata/react@0.3.0
  - zarrextra@0.3.0
  - @spatialdata/avivatorish@0.3.0

## 0.2.5

### Patch Changes

- [#63](https://github.com/Taylor-CCB-Group/SpatialData.js/pull/63) [`c5e6deb`](https://github.com/Taylor-CCB-Group/SpatialData.js/commit/c5e6deb3c5f621844302c80ae92603b3f70cacf3) Thanks [@xinaesthete](https://github.com/xinaesthete)! - Chunk worker enabled by default in vis, and hopefully resolve some bundling issues.

- Updated dependencies [[`c5e6deb`](https://github.com/Taylor-CCB-Group/SpatialData.js/commit/c5e6deb3c5f621844302c80ae92603b3f70cacf3)]:
  - zarrextra@0.2.3
  - @spatialdata/avivatorish@0.2.5
  - @spatialdata/core@0.2.5
  - @spatialdata/react@0.2.5
  - @spatialdata/layers@0.2.5

## 0.2.4

### Patch Changes

- [#60](https://github.com/Taylor-CCB-Group/SpatialData.js/pull/60) [`a582811`](https://github.com/Taylor-CCB-Group/SpatialData.js/commit/a582811d69944f0958256b05d4de1a2a240d09b3) Thanks [@xinaesthete](https://github.com/xinaesthete)! - Export `useSpatialCanvasRendererFromLayerInputs`, `ImageLayerContextProvider`, and the `LayerLoadState` type from the package entry point. These symbols were already defined and intended to be public, but were not re-exported — forcing consumers to patch the built bundle or deep-import from `dist`. They are now reachable directly from `@spatialdata/vis`.

- Updated dependencies [[`a582811`](https://github.com/Taylor-CCB-Group/SpatialData.js/commit/a582811d69944f0958256b05d4de1a2a240d09b3), [`93baa69`](https://github.com/Taylor-CCB-Group/SpatialData.js/commit/93baa695cd9ac5ad42384fba46bd888fd58eb698), [`93baa69`](https://github.com/Taylor-CCB-Group/SpatialData.js/commit/93baa695cd9ac5ad42384fba46bd888fd58eb698)]:
  - @spatialdata/avivatorish@0.2.4
  - @spatialdata/core@0.2.4
  - @spatialdata/react@0.2.4
  - @spatialdata/layers@0.2.4

## 0.2.3

### Patch Changes

- [#57](https://github.com/Taylor-CCB-Group/SpatialData.js/pull/57) [`05145f8`](https://github.com/Taylor-CCB-Group/SpatialData.js/commit/05145f84207fae838733eb07077c4e58d1378d98) Thanks [@xinaesthete](https://github.com/xinaesthete)! - Add MDV integration APIs: `useLayerChannelState` and raster selection stats in `@spatialdata/avivatorish`; Viv extension passthrough (`vivLayerProps`, `vivImageExtensionResolver`, `vivImagePropsResolver`, `ImageLayerContext`) in `@spatialdata/vis`. `ImageChannelPanel` remains internal to `SpatialCanvas` and is not part of the published API.

- Updated dependencies [[`05145f8`](https://github.com/Taylor-CCB-Group/SpatialData.js/commit/05145f84207fae838733eb07077c4e58d1378d98)]:
  - @spatialdata/avivatorish@0.2.3
  - @spatialdata/core@0.2.3
  - @spatialdata/react@0.2.3
  - @spatialdata/layers@0.2.3

## 0.2.2

### Patch Changes

- Updated dependencies []:
  - @spatialdata/avivatorish@0.2.2
  - @spatialdata/core@0.2.2
  - @spatialdata/react@0.2.2
  - @spatialdata/layers@0.2.2

## 0.2.1

### Patch Changes

- Updated dependencies []:
  - @spatialdata/avivatorish@0.2.1
  - @spatialdata/core@0.2.1
  - @spatialdata/react@0.2.1
  - @spatialdata/layers@0.2.1

## 0.2.0

### Minor Changes

- [#48](https://github.com/Taylor-CCB-Group/SpatialData.js/pull/48) [`e20648d`](https://github.com/Taylor-CCB-Group/SpatialData.js/commit/e20648df7ba22b869949b684ab70348978eb8774) Thanks [@xinaesthete](https://github.com/xinaesthete)! - Add support for alternative codecs in zarrextra, with tooling to encode images as JPEG2000 and HTJ2K.

  Zarrita stores can be configured to decode in workers.

- [#49](https://github.com/Taylor-CCB-Group/SpatialData.js/pull/49) [`7c7fdf6`](https://github.com/Taylor-CCB-Group/SpatialData.js/commit/7c7fdf6d86c726381c1eb9e44dd05a2fe08a8fea) Thanks [@xinaesthete](https://github.com/xinaesthete)! - Add the render stack contract for ordered SpatialData and host-layer rendering, with React viewer adapters for resolving stack entries into Viv/deck output.

  Expose richer SpatialCanvas feature-pick events for labels and shapes, including `elementKind`, `spatialElement`, tooltip metadata, and runtime SpatialData context.

### Patch Changes

- Updated dependencies [[`e20648d`](https://github.com/Taylor-CCB-Group/SpatialData.js/commit/e20648df7ba22b869949b684ab70348978eb8774), [`faf55cf`](https://github.com/Taylor-CCB-Group/SpatialData.js/commit/faf55cf9988e0a82449f5dcd3b75c01aa6550587), [`7c7fdf6`](https://github.com/Taylor-CCB-Group/SpatialData.js/commit/7c7fdf6d86c726381c1eb9e44dd05a2fe08a8fea), [`2e74bea`](https://github.com/Taylor-CCB-Group/SpatialData.js/commit/2e74beaf44598debe9692f6da38b6584c4c04fa5)]:
  - @spatialdata/avivatorish@0.2.0
  - @spatialdata/core@0.2.0
  - @spatialdata/layers@0.2.0
  - @spatialdata/react@0.2.0

## 0.1.0

### Minor Changes

- [#42](https://github.com/Taylor-CCB-Group/SpatialData.js/pull/42) [`0a73939`](https://github.com/Taylor-CCB-Group/SpatialData.js/commit/0a73939691b44b44204842e3d408a8d1114c2212) Thanks [@xinaesthete](https://github.com/xinaesthete)! - Prepare the first MDV-targeted alpha prerelease.

### Patch Changes

- Updated dependencies [[`0a73939`](https://github.com/Taylor-CCB-Group/SpatialData.js/commit/0a73939691b44b44204842e3d408a8d1114c2212)]:
  - @spatialdata/core@0.1.0
  - @spatialdata/react@0.1.0
  - @spatialdata/layers@0.1.0
  - @spatialdata/avivatorish@0.1.0

## 0.1.0-next.0

### Minor Changes

- [#42](https://github.com/Taylor-CCB-Group/SpatialData.js/pull/42) [`0a73939`](https://github.com/Taylor-CCB-Group/SpatialData.js/commit/0a73939691b44b44204842e3d408a8d1114c2212) Thanks [@xinaesthete](https://github.com/xinaesthete)! - Prepare the first MDV-targeted alpha prerelease.

### Patch Changes

- Updated dependencies [[`0a73939`](https://github.com/Taylor-CCB-Group/SpatialData.js/commit/0a73939691b44b44204842e3d408a8d1114c2212)]:
  - @spatialdata/core@0.1.0-next.0
  - @spatialdata/react@0.1.0-next.0
  - @spatialdata/layers@0.1.0-next.0
  - @spatialdata/avivatorish@0.1.0-next.0
