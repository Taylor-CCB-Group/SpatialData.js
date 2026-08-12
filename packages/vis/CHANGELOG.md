# @spatialdata/vis

## 0.7.0

### Minor Changes

- [#144](https://github.com/Taylor-CCB-Group/SpatialData.js/pull/144) [`b7059d8`](https://github.com/Taylor-CCB-Group/SpatialData.js/commit/b7059d8fe10befbc3110814cee0809c359aa1eb2) Thanks [@xinaesthete](https://github.com/xinaesthete)! - Export the points feature-state API from the package entry.

  `PointsFeatureStateProvider`, `usePointsFeatureState` and the points engine types
  were exported from `SpatialCanvas/public.ts` — and the comment there tells you to
  pull `pointsEngine` off the renderer hook and wrap a subtree in the provider — but
  `src/index.ts` never re-exported them. Since the package publishes only a `"."`
  export, there was no deep-import route either, so the documented integration path
  was unreachable to anyone outside this repo: the demo panels work because they
  import by relative path.

  Adds `PointsFeatureStateProvider` and `usePointsFeatureState`, plus the types
  `PointsDataEngine`, `PointsLoadTarget`, `PointsFeatureState`,
  `PointsFeatureSelection` and `PointsFeatureStateProviderProps`. No behaviour
  change; this is the surface an embedding application needs to build its own points
  feature UI rather than reimplementing the engine subscription.

### Patch Changes

- Updated dependencies []:
  - @spatialdata/core@0.7.0
  - @spatialdata/react@0.7.0
  - @spatialdata/layers@0.7.0
  - @spatialdata/avivatorish@0.7.0

## 0.6.0

### Minor Changes

- [#142](https://github.com/Taylor-CCB-Group/SpatialData.js/pull/142) [`a0a3cc4`](https://github.com/Taylor-CCB-Group/SpatialData.js/commit/a0a3cc456dfaa139d7afbe886acb872bfebad86e) Thanks [@xinaesthete](https://github.com/xinaesthete)! - Make a column's colours a property of the column, not of the features that loaded.

  Three things decided the encoding from whatever happened to be in view, so two
  layers over one annotation could disagree about what a colour means — which reads
  as a data difference rather than as a bug:

  - Category indices were assigned in **first-seen feature order**. A shapes layer
    walks the loader's geometry order and a labels layer walks the raster's ids, so
    the same `cell_type` column rendered in two different schemes on the two kinds.
    (`labelColorEncoding.spec.ts` claimed to cover this, but only pinned the indices
    on one kind; it now actually builds the column through both.) Categories are now
    ordered by value, with numeric-looking values ordered numerically so cluster 10
    follows cluster 9 rather than cluster 1.
  - Positional palettes cannot survive a category being **absent from a view** at
    all: `tumour` genuinely is the second category present when `stroma` is not.
    `categoricalPalette` therefore also accepts `{ byValue: { Tumour: [200, 30, 30] } }`,
    with an optional `fallback` for values it does not name (`'oklab'` by default, so
    an unnamed category keeps its own hue instead of merging into one bucket). This
    is the form to prefer in a saved stack, and the only form an embedding
    application can use to make a layer agree with its own charts.
  - The continuous ramp measured its extent from the loaded features. `numericDomain`
    pins it to the column's own range; values outside clamp rather than extrapolate.

  `numericRamp` also takes more than two stops now, spaced evenly across the domain,
  because the ramps people actually use are not two-stop — viridis, a diverging
  red/white/blue, or whatever a host has already chosen for the same column in its
  own UI. Approximating one by its endpoints loses the midpoint that made it
  meaningful. `numericScale: 'symlog'` goes with it: a counts or expression column
  whose mass sits near zero with a long tail collapses into the first stop under a
  linear position. Symmetric log rather than plain log, because these columns reach
  zero and below.

  `featureColorSchemeSignature` now takes the scheme as one object
  (`featureColorSchemeSignature(config.fillColorByColumn)`) rather than three
  positional arguments, so adding a term to the encoding cannot leave a call site
  silently keying on the old set — the failure mode there being a layer that keeps
  serving the previous colours after the scheme changed. Named palettes are
  serialised in sorted key order, since object key order is insertion order and a
  host rebuilding its palette each render need not insert in a stable one.

  **Colours will change** for existing categorical configs that relied on the
  implicit first-seen order. Pass `categoricalPalette: { byValue }` to fix a scheme
  in place.

### Patch Changes

- [#142](https://github.com/Taylor-CCB-Group/SpatialData.js/pull/142) [`a0a3cc4`](https://github.com/Taylor-CCB-Group/SpatialData.js/commit/a0a3cc456dfaa139d7afbe886acb872bfebad86e) Thanks [@xinaesthete](https://github.com/xinaesthete)! - Make a fill-colour column (or tooltip field) switch actually apply for a host that
  edits its layer configs in place.

  Two independent breaks sat between "the user picked a different column" and "the
  canvas shows it", and a host only hit them together. [#119](https://github.com/Taylor-CCB-Group/SpatialData.js/issues/119) fixed the third thing in
  that chain — the load-window blank — which is why the remaining two read as "the
  colours just never change".

  **The change never reached the resolver.** `useLayerData`'s reconcile effect is the
  one place a config change turns into a request, and it was keyed on the identity of
  `layers` and the configs inside it. That assumes the caller allocates a fresh config
  per edit; MDV's render-stack adapter deliberately does the opposite, keeping one
  `LayerConfig` per Stack Entry so a cosmetic edit does not look structural and
  re-enter geometry loads. Under that caller the effect never re-ran: the new column
  was never requested, `getShapeFillColorEntry` / `getLabelFillColorEntry` went on
  correctly serving last-good rows, and last-good was all there would ever be. The
  effect now also depends on `describeResolveInputs` — a value key over exactly the
  config fields each resolver's `plan()` reads, recomputed per render because a
  mutation is invisible to any memo. It holds scalars and short id lists only; a
  palette swap or an opacity drag does not move it, so nothing replans on a slider.

  **The settle never reached React.** `SpatialEntryStore` subscribed to its resolvers
  in its constructor and tore that bridge down in `dispose()` — which `useLayerData`
  calls from an effect cleanup. An effect cleanup is not "the end": StrictMode's dev
  double-mount runs cleanup and then re-runs the effect against the same memoised
  store, after which the store was permanently deaf to its own resolvers. Every async
  settle from then on was dropped, so rows that landed after a switch did not repaint
  until an unrelated re-render (a pan) came along. The bridge is now attached on the
  first listener and detached on the last, so it is exactly as long-lived as someone
  caring about it and survives any number of remounts. `getVersion()` became a derived
  sum of the resolvers' versions rather than a counter the bridge maintained, so it
  stays true whether or not anything is subscribed.

  No public API change. Verified against MDV driving only `fillColorByColumn` on a
  labels layer: switching to a column that has to be fetched now repaints on its own.

- [#120](https://github.com/Taylor-CCB-Group/SpatialData.js/pull/120) [`f0f8df1`](https://github.com/Taylor-CCB-Group/SpatialData.js/commit/f0f8df1a1acebffc450fd254c72bf46b5596ef4c) Thanks [@xinaesthete](https://github.com/xinaesthete)! - Drop the direct `geotiff` dependency from both packages.

  `@spatialdata/vis` declared it but never imported it. `@spatialdata/avivatorish`
  imported `fromUrl` / `fromBlob` in exactly one place, feeding a chain of
  non-exported Avivator scaffolding for plain multi-TIFF inputs that nothing
  reached — `createLoader` is OME-NGFF-only by design. Both are now gone, along
  with the matching Vite `external` entries.

  No public API changes, and nothing to lose on the OME-TIFF side: there was no
  OME-TIFF loading path to break. The only loaders here are `loadOmeZarr` and
  `loadOmeZarrMultiscalesData`, and the exported `OME_TIFF` type is a type-only
  derivation from viv's `loadOmeTiff` signature — `import type`, so it costs
  nothing at runtime and needs no `geotiff` of our own.

  Declaring the dependency only ever added a third copy to consumers' trees, and
  pinned us to a version we could neither exercise nor usefully advance: were an
  OME-TIFF path ever added, it would go through viv, which resolves its own
  `geotiff` (`^2.0.5`) regardless, and geotiff 3's decoder API is a viv-side
  blocker (hms-dbmi/viv#951), not ours.

- [#142](https://github.com/Taylor-CCB-Group/SpatialData.js/pull/142) [`a0a3cc4`](https://github.com/Taylor-CCB-Group/SpatialData.js/commit/a0a3cc456dfaa139d7afbe886acb872bfebad86e) Thanks [@xinaesthete](https://github.com/xinaesthete)! - Publish sourcemaps, and survive a colour scheme that does not match its own type.

  `core` shipped `index.js.map`; `layers`, `vis`, `avivatorish` and `react` did not.
  A crash inside one of them reached a consumer as
  `Le (…/.vite/deps/@spatialdata_layers.js:396)` — an esbuild-minified name with
  nothing to map it back to. An embedding application has only the built artifact to
  debug against, so it has to carry a map.

  `resolveCategoricalPalette` and the ramp sampler now always return a colour. A
  scheme arrives from a saved Render Stack, so its type is a claim about JSON rather
  than a guarantee: a palette object with no `byValue`, a list with a hole in it, or
  a ramp with fewer than two stops all used to return `undefined` and fail several
  frames later in the arithmetic that reads `rgb[0]`. Wrong colours can be seen and
  reported; that `TypeError` cannot.

- Updated dependencies [[`a0a3cc4`](https://github.com/Taylor-CCB-Group/SpatialData.js/commit/a0a3cc456dfaa139d7afbe886acb872bfebad86e), [`a0a3cc4`](https://github.com/Taylor-CCB-Group/SpatialData.js/commit/a0a3cc456dfaa139d7afbe886acb872bfebad86e), [`f0f8df1`](https://github.com/Taylor-CCB-Group/SpatialData.js/commit/f0f8df1a1acebffc450fd254c72bf46b5596ef4c), [`a0a3cc4`](https://github.com/Taylor-CCB-Group/SpatialData.js/commit/a0a3cc456dfaa139d7afbe886acb872bfebad86e)]:
  - @spatialdata/core@0.6.0
  - @spatialdata/layers@0.6.0
  - @spatialdata/avivatorish@0.6.0
  - @spatialdata/react@0.6.0

## 0.5.0

### Patch Changes

- [#119](https://github.com/Taylor-CCB-Group/SpatialData.js/pull/119) [`1c1984d`](https://github.com/Taylor-CCB-Group/SpatialData.js/commit/1c1984d3e7f45603c7bfced8c646043b0c8f2a13) Thanks [@xinaesthete](https://github.com/xinaesthete)! - Keep the last-good fill colours while a `fillColorByColumn` column's rows are loading.

  A selected column with no rows yet was treated as "no colours": the projection wrote
  `fillColorByFeatureId: {}`, so features dropped to the flat fill (shapes) or channel
  colour (labels) for the whole load window. Labels blinked on every column _switch_ —
  `LabelsResolver` caches rows per element+column, so a switch always has a frame with
  no rows.

  Not-ready is now a loading state. The entry getters keep serving the previous entry
  (same element only — label ids collide across elements), and the feature-state merges
  leave the caller's `featureState` alone when there is no entry at all instead of
  clearing it. The stale entry's identity still drives the rebuild, so the real colours
  appear as soon as the rows settle; a failed load keeps the last good colours and
  surfaces through the resolver's notices as before.

- [#109](https://github.com/Taylor-CCB-Group/SpatialData.js/pull/109) [`3215b3b`](https://github.com/Taylor-CCB-Group/SpatialData.js/commit/3215b3b5346f7f751a04f51a8a3d9e3623fa2505) Thanks [@xinaesthete](https://github.com/xinaesthete)! - Track spatialdata 0.8.0 in the fixture matrix; README quick-starts now point at
  `test-fixtures/v0.8.0/blobs.zarr`.

  No source changes — 0.8.0 reads correctly today. It does change the store on disk
  in two ways worth knowing about, both now covered by the integration matrix:

  - multiscale dataset paths are `s0`/`s1`/`s2` rather than `0`/`1`/`2`, so level
    names must come from `multiscales[0].datasets[].path` and never from position;
  - the AnnData `obs`/`var` index is written as a `nullable-string-array` _group_
    (a `values` array beside a `mask` array) instead of a plain `string-array`
    array. `loadObsIndex()` and the table source's `loadVarIndex()` both decode it.

  Note that `anndata.js`'s `varNames()` cannot read the new index at all — read var
  names through the table source, not the AnnData wrapper.

- Updated dependencies [[`423448b`](https://github.com/Taylor-CCB-Group/SpatialData.js/commit/423448b13e6a2cb07324faa9b318dca2c6ba1c59), [`8453d3c`](https://github.com/Taylor-CCB-Group/SpatialData.js/commit/8453d3ce1effba9078cc8b782804cb6a69bce654), [`3215b3b`](https://github.com/Taylor-CCB-Group/SpatialData.js/commit/3215b3b5346f7f751a04f51a8a3d9e3623fa2505), [`2c7e3c3`](https://github.com/Taylor-CCB-Group/SpatialData.js/commit/2c7e3c31ab3ce4c0fd509ff325bc8c02445fdfb0)]:
  - zarrextra@0.4.0
  - @spatialdata/layers@0.5.0
  - @spatialdata/core@0.5.0
  - @spatialdata/avivatorish@0.5.0
  - @spatialdata/react@0.5.0

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

### Patch Changes

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

- Updated dependencies [[`baa54e9`](https://github.com/Taylor-CCB-Group/SpatialData.js/commit/baa54e9d25524901c6f33804da3b02d54bb89811), [`baa54e9`](https://github.com/Taylor-CCB-Group/SpatialData.js/commit/baa54e9d25524901c6f33804da3b02d54bb89811), [`baa54e9`](https://github.com/Taylor-CCB-Group/SpatialData.js/commit/baa54e9d25524901c6f33804da3b02d54bb89811), [`baa54e9`](https://github.com/Taylor-CCB-Group/SpatialData.js/commit/baa54e9d25524901c6f33804da3b02d54bb89811), [`5c0d6dd`](https://github.com/Taylor-CCB-Group/SpatialData.js/commit/5c0d6ddf9f04dc7cf1c3ee962c85fbfedcff3796), [`baa54e9`](https://github.com/Taylor-CCB-Group/SpatialData.js/commit/baa54e9d25524901c6f33804da3b02d54bb89811), [`baa54e9`](https://github.com/Taylor-CCB-Group/SpatialData.js/commit/baa54e9d25524901c6f33804da3b02d54bb89811), [`baa54e9`](https://github.com/Taylor-CCB-Group/SpatialData.js/commit/baa54e9d25524901c6f33804da3b02d54bb89811), [`1925695`](https://github.com/Taylor-CCB-Group/SpatialData.js/commit/1925695a15e1d354bc8100e55fb6bfca85bfc951), [`ed2979d`](https://github.com/Taylor-CCB-Group/SpatialData.js/commit/ed2979de3ecf1eca95d2d78cabf79622b13c9c32), [`0e0f2b5`](https://github.com/Taylor-CCB-Group/SpatialData.js/commit/0e0f2b5bd3a905c5cf4559ea80fe7017d195a083), [`886c6f2`](https://github.com/Taylor-CCB-Group/SpatialData.js/commit/886c6f2750998aaaf39c7ca617f048ecedade3bb)]:
  - @spatialdata/core@0.4.0
  - @spatialdata/layers@0.4.0
  - @spatialdata/avivatorish@0.4.0
  - @spatialdata/react@0.4.0

## 0.3.1

### Patch Changes

- Updated dependencies [[`671dd60`](https://github.com/Taylor-CCB-Group/SpatialData.js/commit/671dd602dda759bae1fe78ffd2572fba496ff6b1)]:
  - @spatialdata/layers@0.3.1
  - @spatialdata/core@0.3.1
  - @spatialdata/react@0.3.1
  - @spatialdata/avivatorish@0.3.1

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

- [#69](https://github.com/Taylor-CCB-Group/SpatialData.js/pull/69) [`e343a72`](https://github.com/Taylor-CCB-Group/SpatialData.js/commit/e343a721ce949fd9592c8ead2edec9a238f70f92) Thanks [@xinaesthete](https://github.com/xinaesthete)! - Switch HTJ2K codec from `@cornerstonejs/codec-openjph` to `openjph-wasm`, which correctly round-trips multi-component (volumetric) HTJ2K data. The cornerstone build silently dropped components 2..N on decode; `openjph-wasm` handles arbitrary component counts losslessly.

  Also adds true z>1 multi-component chunk support: z-planes are now encoded as components of a single codestream rather than one plane per chunk. Exports `Htj2kPlane` from the package index.

- Updated dependencies [[`bd594e2`](https://github.com/Taylor-CCB-Group/SpatialData.js/commit/bd594e2e1efddffb4b9280d0970abd0aa84fed0e), [`e94ba97`](https://github.com/Taylor-CCB-Group/SpatialData.js/commit/e94ba97d472bce02dc2efc4c561e478ed42645de), [`ab1b809`](https://github.com/Taylor-CCB-Group/SpatialData.js/commit/ab1b80989b66e27950f74b503c91348b90b60827), [`6e153a6`](https://github.com/Taylor-CCB-Group/SpatialData.js/commit/6e153a6e3e7e564d31b835828615d8145b6bc805), [`8607083`](https://github.com/Taylor-CCB-Group/SpatialData.js/commit/86070837958ffb5761d004446b5a23a8520d6c79), [`e343a72`](https://github.com/Taylor-CCB-Group/SpatialData.js/commit/e343a721ce949fd9592c8ead2edec9a238f70f92)]:
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
