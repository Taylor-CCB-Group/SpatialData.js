# @spatialdata/layers

## 0.5.0

### Patch Changes

- [#108](https://github.com/Taylor-CCB-Group/SpatialData.js/pull/108) [`8453d3c`](https://github.com/Taylor-CCB-Group/SpatialData.js/commit/8453d3ce1effba9078cc8b782804cb6a69bce654) Thanks [@xinaesthete](https://github.com/xinaesthete)! - Stop bundling luma.gl into the published `@spatialdata/layers` artifact.

  The build externalized only the specifiers this package imports directly, so
  `@luma.gl/core`, `/engine` and `/shadertools` (plus `@probe.gl/*`) were pulled in
  transitively and shipped inside `dist/index.js` — 238 kB down to 92 kB now that they
  are not.

  Size was the least of it. deck.gl, Viv and this package must share ONE luma runtime.
  A consumer that also loads deck.gl got two `ShaderAssembler` classes, and
  `ShaderAssembler.getDefaultShaderAssembler()` is a static — so "the default shader
  assembler" meant different objects to deck and to Viv. Viv's `VivShaderAssembler`
  builds itself by copying that default's modules and hook functions, so it could copy
  from an assembler deck had never registered anything on, and every Viv-derived layer —
  labels included — then failed to compile its vertex shader for want of deck's
  `DECKGL_FILTER_*` hooks.

  The externals are now whole families by regex rather than a list of today's imports,
  matching what `@spatialdata/vis` has always done.

- Updated dependencies [[`3215b3b`](https://github.com/Taylor-CCB-Group/SpatialData.js/commit/3215b3b5346f7f751a04f51a8a3d9e3623fa2505), [`2c7e3c3`](https://github.com/Taylor-CCB-Group/SpatialData.js/commit/2c7e3c31ab3ce4c0fd509ff325bc8c02445fdfb0)]:
  - @spatialdata/core@0.5.0

## 0.4.0

### Minor Changes

- [#95](https://github.com/Taylor-CCB-Group/SpatialData.js/pull/95) [`baa54e9`](https://github.com/Taylor-CCB-Group/SpatialData.js/commit/baa54e9d25524901c6f33804da3b02d54bb89811) Thanks [@xinaesthete](https://github.com/xinaesthete)! - Decide continuous vs categorical from the column's declared kind, and let callers
  configure missing values.

  `TableElement.getObsColumnKinds` reports what the store says each obs column is —
  `numeric`, `categorical`, `string` or `boolean` — and `loadAssociatedTableFeatureRows`
  carries it alongside the values as `extraColumnKinds`. It is **synchronous**: opening a
  store already reads every node's attributes and array metadata into the tree, so a caller
  can ask what a column is before deciding whether to load it. Both zarr generations are
  read (v3 `data_type`, v2 numpy typestrings). `'auto'` mode now trusts that in
  preference to sniffing stringified values, which was wrong at both edges: one `NaN` made a
  float column look non-numeric, and integer cluster codes looked like a continuum. Value
  sniffing remains only as the fallback when no kind is available.

  `fillColorByColumn.missingValues` configures the rest: `treatAsMissing` adds
  store-specific sentinel strings (`'NA'`, `'unknown'`, …) that only the caller can
  recognise, and `render` chooses whether a feature with no value keeps the layer default,
  is hidden, or takes an explicit colour. `null` and `NaN` are always missing and are not
  configurable. Sentinels are excluded before the mode decision, the numeric extent and the
  category set, so a sentinel never becomes a category or drags a ramp.

- [#95](https://github.com/Taylor-CCB-Group/SpatialData.js/pull/95) [`baa54e9`](https://github.com/Taylor-CCB-Group/SpatialData.js/commit/baa54e9d25524901c6f33804da3b02d54bb89811) Thanks [@xinaesthete](https://github.com/xinaesthete)! - Let a host hand in precomputed feature colours as a buffer, for shapes and labels.

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

- [#95](https://github.com/Taylor-CCB-Group/SpatialData.js/pull/95) [`baa54e9`](https://github.com/Taylor-CCB-Group/SpatialData.js/commit/baa54e9d25524901c6f33804da3b02d54bb89811) Thanks [@xinaesthete](https://github.com/xinaesthete)! - Let `fillColorByColumn` carry a colour scheme, and default categorical colouring to the
  unbounded OkLab scheme.

  `fillColorByColumn` on both shapes and labels layers now takes `categoricalPalette`
  (`'oklab'`, or your own RGB list, which cycles) and `numericRamp`. Both are
  JSON-serializable, so they survive a saved Render Stack.

  **Behaviour change:** the categorical default is now `'oklab'` — the same golden-angle
  OKLCh scheme `@spatialdata/layers` already used for points colour-by-feature. The previous
  six-colour palette cycled, so a column with more than six categories silently drew two
  categories in the same colour; the OkLab scheme is a pure function of the category index
  and has no length. Pass an explicit RGB list to pin specific colours.

- [#95](https://github.com/Taylor-CCB-Group/SpatialData.js/pull/95) [`baa54e9`](https://github.com/Taylor-CCB-Group/SpatialData.js/commit/baa54e9d25524901c6f33804da3b02d54bb89811) Thanks [@xinaesthete](https://github.com/xinaesthete)! - Filter and colour annotated labels elements with the same API as shapes.

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

- [#103](https://github.com/Taylor-CCB-Group/SpatialData.js/pull/103) [`5c0d6dd`](https://github.com/Taylor-CCB-Group/SpatialData.js/commit/5c0d6ddf9f04dc7cf1c3ee962c85fbfedcff3796) Thanks [@xinaesthete](https://github.com/xinaesthete)! - Highlight the labels feature under the cursor, the way shapes already do.

  Nothing to configure on either canvas surface: the highlight follows the same hover pick
  that feeds the tooltip, so it respects `hoverTooltipMode`. Hosts driving `LabelsLayer`
  directly get `highlightedLabelId` and an optional `highlightColor`.

- [#95](https://github.com/Taylor-CCB-Group/SpatialData.js/pull/95) [`baa54e9`](https://github.com/Taylor-CCB-Group/SpatialData.js/commit/baa54e9d25524901c6f33804da3b02d54bb89811) Thanks [@xinaesthete](https://github.com/xinaesthete)! - Add `featureState` to the labels sublayer schema, and export `SpatialLabelsSublayer`.

  `spatialLabelsSublayerSchema` now carries `fillColorByFeatureId`, `hiddenFeatureIds`,
  `fadedFeatureIds` and `filteredOpacityMultiplier` — the same field names and meanings
  `spatialShapesSublayerSchema` already had, keyed by the label's integer instance id as a
  string. It omits `strokeColorByFeatureId`: a label's outline is derived from its fill in
  the bitmask shader, so there is no per-label stroke to override.

  This closes the last place where a labels layer could not express what a shapes layer
  could.

### Patch Changes

- [#95](https://github.com/Taylor-CCB-Group/SpatialData.js/pull/95) [`baa54e9`](https://github.com/Taylor-CCB-Group/SpatialData.js/commit/baa54e9d25524901c6f33804da3b02d54bb89811) Thanks [@xinaesthete](https://github.com/xinaesthete)! - Depend on `@luma.gl/core` directly, so GPU resource types come from the library rather
  than being restated locally. `LabelsLayer` now types its LUT texture as luma's `Texture`;
  the package already depends on `@luma.gl/engine` and cannot realistically be used without
  luma core.

- [#95](https://github.com/Taylor-CCB-Group/SpatialData.js/pull/95) [`baa54e9`](https://github.com/Taylor-CCB-Group/SpatialData.js/commit/baa54e9d25524901c6f33804da3b02d54bb89811) Thanks [@xinaesthete](https://github.com/xinaesthete)! - Fix numeric columns being coloured as categorical when they contain `NaN`.

  `'auto'` mode asks whether every non-empty value parses as a finite number, and a
  non-finite number stringified to `"NaN"` — a non-empty value that does not parse. So a
  single failed embedding in a `UMAP1` column made the whole column categorical, and
  categorical mode then gave every distinct float its own colour.

  A non-finite `number` now normalises as missing, the way `null` already did: it does not
  influence the mode, and the cell keeps the layer's default colour. The _string_ `"NaN"` in
  a string column is untouched — there it may be a real category.

- [#98](https://github.com/Taylor-CCB-Group/SpatialData.js/pull/98) [`ed2979d`](https://github.com/Taylor-CCB-Group/SpatialData.js/commit/ed2979de3ecf1eca95d2d78cabf79622b13c9c32) Thanks [@xinaesthete](https://github.com/xinaesthete)! - Bump deck.gl to 9.3.7 and the luma.gl ecosystem to 9.3.6.

  The catalog entries for the `@deck.gl/*` packages move from `~9.3.5` to `~9.3.7`
  and the `@luma.gl/*` entries to `~9.3.6` (the latest 9.3 patch of each).
  `@spatialdata/layers` pinned `@luma.gl/engine` outside the catalog at `^9.3.5`;
  it now uses `catalog:` like every other deck/luma dependency, so the whole
  ecosystem stays on one version.

  The lockfile is also deduped: `@luma.gl/shadertools`, `@luma.gl/webgl` and
  `@luma.gl/gltf` reach us only as peers of the deck packages, so they had stayed
  at 9.3.5 while the directly-declared luma packages moved to 9.3.6. A mixed luma
  tree is the kind of thing that breaks deck at runtime rather than at build time,
  so they are now collapsed onto 9.3.6 with the rest.

- Updated dependencies [[`baa54e9`](https://github.com/Taylor-CCB-Group/SpatialData.js/commit/baa54e9d25524901c6f33804da3b02d54bb89811), [`baa54e9`](https://github.com/Taylor-CCB-Group/SpatialData.js/commit/baa54e9d25524901c6f33804da3b02d54bb89811), [`1925695`](https://github.com/Taylor-CCB-Group/SpatialData.js/commit/1925695a15e1d354bc8100e55fb6bfca85bfc951), [`0e0f2b5`](https://github.com/Taylor-CCB-Group/SpatialData.js/commit/0e0f2b5bd3a905c5cf4559ea80fe7017d195a083), [`886c6f2`](https://github.com/Taylor-CCB-Group/SpatialData.js/commit/886c6f2750998aaaf39c7ca617f048ecedade3bb)]:
  - @spatialdata/core@0.4.0

## 0.3.1

### Patch Changes

- [#90](https://github.com/Taylor-CCB-Group/SpatialData.js/pull/90) [`671dd60`](https://github.com/Taylor-CCB-Group/SpatialData.js/commit/671dd602dda759bae1fe78ffd2572fba496ff6b1) Thanks [@xinaesthete](https://github.com/xinaesthete)! - Fix a production shader compilation error when rendering shapes layers.

- Updated dependencies []:
  - @spatialdata/core@0.3.1

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

- [#89](https://github.com/Taylor-CCB-Group/SpatialData.js/pull/89) [`e94ba97`](https://github.com/Taylor-CCB-Group/SpatialData.js/commit/e94ba97d472bce02dc2efc4c561e478ed42645de) Thanks [@xinaesthete](https://github.com/xinaesthete)! - Points: feature selection now works on large elements, and persists by name.

  **Selections persist as feature names.** `PointsLayerConfig.featureNames` is the
  durable, serializable form and what the UI writes. Codes are app-assigned for a
  dictionary-only element (a Xenium `transcripts` has `feature_name` and no code
  column), so a stored code could silently come back meaning a different feature.
  `featureCodes` still works and still takes effect at runtime, but names win when
  both are present. `resolveFeatureSelectionCodes` / `featureNamesForCodes` are
  exported from `@spatialdata/core` for converting between the two.

  **The feature scan now completes on large elements.** Previously, selecting a
  feature on a multi-million-row element frequently never resolved — the scan
  plateaued part-way through and the layer sat there. It now reads through
  `ParquetFile.stream({ columns, rowGroups })`, which fetches per column chunk, so
  the projection reaches the network instead of pulling whole row groups — all 12
  columns of a Xenium `transcripts` to use three. The scan runs in the points
  worker, keeping the parquet decode off the main thread. Selecting one gene from a 12.1M-row element now
  settles in ~1.0s, with main-thread time roughly a third of what the pre-streaming
  path cost.

  Also fixed along the way: a full-dataset catalog scan being silently cancelled by
  the resident preview settling underneath it (leaving counts stuck and colours
  mismatched); row-group chunks handing out the cached footer buffer, which the
  worker transfer detached (`DataCloneError`, dropping the element onto whole-file
  reads); parquet part layout being re-probed on every call; a server that answers
  a directory path with 500 rather than 404 wedging part traversal; and point size
  not accounting for an element's transform scale.

  Known limitation: for a dictionary-only element the fallback catalog path cannot
  tally per-feature counts, and it settles _successfully_ without them — so the
  retry path does not repair it and counts stay absent for the session. Names and
  selection are unaffected. Treat a missing count as unknown, not zero, and do not
  read the presence of counts as a signal that the scan completed.

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

- Updated dependencies [[`e94ba97`](https://github.com/Taylor-CCB-Group/SpatialData.js/commit/e94ba97d472bce02dc2efc4c561e478ed42645de), [`ab1b809`](https://github.com/Taylor-CCB-Group/SpatialData.js/commit/ab1b80989b66e27950f74b503c91348b90b60827), [`6e153a6`](https://github.com/Taylor-CCB-Group/SpatialData.js/commit/6e153a6e3e7e564d31b835828615d8145b6bc805)]:
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
