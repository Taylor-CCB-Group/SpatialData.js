# @spatialdata/core

## 0.5.1

## 0.5.0

### Minor Changes

- [#105](https://github.com/Taylor-CCB-Group/SpatialData.js/pull/105) [`2c7e3c3`](https://github.com/Taylor-CCB-Group/SpatialData.js/commit/2c7e3c31ab3ce4c0fd509ff325bc8c02445fdfb0) Thanks [@xinaesthete](https://github.com/xinaesthete)! - Export runtime type guards and accessors for zarr tree nodes.

  `ZarrTree` admits a group or a `LazyZarrArray` at every key and shipped no way to tell
  them apart, so consumers hand-rolled the check — and the obvious `typeof node === 'object'`
  test is wrong, because a lazy array is an object too and its own properties (`get`) then
  read as child keys. `zarrextra` now exports the discrimination itself:

  - `isLazyZarrArray` / `isZarrGroup` — the guards, discriminating on `ZARRAY_KEY`.
  - `getChildNode` / `getChildGroup` / `getChildArray` — "the node at this path, if it is
    the kind I need", which is the shape most call sites actually want.
  - `getNodeAttrs` / `getArrayMetadata` — the symbol-keyed payloads of either kind of node.
  - `getArrayDtype` / `normalizeDtype` — the data type of an array node, from consolidated
    metadata alone, with v2's numpy typestrings (`<f8`, `|O`) and v3's names (`float64`,
    `string`) folded into one vocabulary: `zarrita`'s own `DataType`, so a check made
    against tree metadata and the same check made against an opened array cannot disagree.
  - `isTextDataType` — "do these values need decoding to strings", covering v3 `string`,
    v2 fixed-width unicode/bytes, _and_ `v2:object`. `zarrita`'s `isDataType(dtype, 'string')`
    excludes the last, and testing for one spelling without the other is what makes a
    reader hand back raw integer codes where labels were expected.

  `LazyZarrArray`'s `ZARRAY_KEY` payload is typed as `ZarrArrayMetadata` instead of an
  untyped record, so `dtype` and `data_type` can no longer be read without narrowing —
  reading the v2 spelling off a v3 node and silently getting `undefined` stops type-checking.

  `@spatialdata/core` re-exports all of the above and uses them throughout: `parsed` is
  narrowed to a group once in `AbstractElement`, so no element subclass sees the union, and
  `classifyObsColumnNode`, `getObsGroup` and `loadElements` drop their casts.
  `AnnDataSource` now asks `isTextDataType` about an opened array's dtype, so the
  classification a UI sees before loading a column and the decoding it gets when the column
  loads come from one definition.

  `readNullableArray`, `isNullableEncoding` and `NULLABLE_ENCODING_KINDS` are now public
  too. Guards make "is this group a categorical or a nullable column?" _expressible_; those
  make it _answerable_ without every consumer re-deriving AnnData's on-disk layout.

### Patch Changes

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

- Updated dependencies [[`423448b`](https://github.com/Taylor-CCB-Group/SpatialData.js/commit/423448b13e6a2cb07324faa9b318dca2c6ba1c59), [`2c7e3c3`](https://github.com/Taylor-CCB-Group/SpatialData.js/commit/2c7e3c31ab3ce4c0fd509ff325bc8c02445fdfb0)]:
  - zarrextra@0.4.0

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

- [#95](https://github.com/Taylor-CCB-Group/SpatialData.js/pull/95) [`baa54e9`](https://github.com/Taylor-CCB-Group/SpatialData.js/commit/baa54e9d25524901c6f33804da3b02d54bb89811) Thanks [@xinaesthete](https://github.com/xinaesthete)! - Add `featureState` to the labels sublayer schema, and export `SpatialLabelsSublayer`.

  `spatialLabelsSublayerSchema` now carries `fillColorByFeatureId`, `hiddenFeatureIds`,
  `fadedFeatureIds` and `filteredOpacityMultiplier` — the same field names and meanings
  `spatialShapesSublayerSchema` already had, keyed by the label's integer instance id as a
  string. It omits `strokeColorByFeatureId`: a label's outline is derived from its fill in
  the bitmask shader, so there is no per-label stroke to override.

  This closes the last place where a labels layer could not express what a shapes layer
  could.

- [#101](https://github.com/Taylor-CCB-Group/SpatialData.js/pull/101) [`1925695`](https://github.com/Taylor-CCB-Group/SpatialData.js/commit/1925695a15e1d354bc8100e55fb6bfca85bfc951) Thanks [@xinaesthete](https://github.com/xinaesthete)! - Read AnnData's nullable-encoded columns, and report their kind.

  A nullable column is a **group** of `values` + `mask`, not an array, so opening its
  path as an array fails outright. The visible symptom is usually a missing _index_
  rather than a missing value, because `obs/_index` and `var/_index` are ordinary
  columns — a table would load with `varN` in place of gene names, or with no row ids.
  This is not a legacy shape to tolerate: AnnData 0.13 defaults to zarr v3 and writes
  string columns this way by default, `_index` included, so it is what a freshly
  written `spatialdata` store looks like.

  All three nullable encodings are read (`nullable-string-array`, `nullable-integer`,
  `nullable-boolean`), with the mask honoured — a masked entry decodes as `null`, which
  the missing-value handling already treats as absent, so it stays distinguishable from
  a real `0` or `''` rather than being silently rendered as one.

  `getObsColumnKinds` recognises the same three. Without this the kind lookup fell
  through to array metadata that a group does not have and returned `undefined`,
  sending `'auto'` mode back to sniffing decoded values for exactly the columns AnnData
  now writes by default — the case that lookup exists to avoid.

  Also fixes zarr v3 categoricals decoding to their raw integer codes. The categories
  array is written as `string` on v3, and the text check tested for one v2 spelling of
  that dtype (`v2:object`), so the column resolved to codes — plausible-looking numbers
  rather than an error. The check now asks zarrita whether the dtype is text, which
  covers v3 `string` and v2 `U`/`S` alike, and pandas' `-1` missing code maps to `null`
  instead of indexing off the end of the categories.

### Patch Changes

- [#104](https://github.com/Taylor-CCB-Group/SpatialData.js/pull/104) [`0e0f2b5`](https://github.com/Taylor-CCB-Group/SpatialData.js/commit/0e0f2b5bd3a905c5cf4559ea80fe7017d195a083) Thanks [@xinaesthete](https://github.com/xinaesthete)! - Run the package unit tests in CI.

  `test:unit` was `vitest run --exclude tests/integration/**` with the glob
  unquoted, so the shell expanded it before vitest saw it. `--exclude` took the
  first match and the second became a positional filename filter, which meant the
  command ran exactly one file — the integration test it was meant to exclude —
  and no package unit test at all. CI reported that as a pass.

  Quoting alone would have surfaced 49 failures: the root config declared a single
  `node` environment for every file it collected, so the React hook tests in
  `react`, `vis` and `avivatorish` failed with `document is not defined`. They pass
  under `pnpm test`, which uses each package's own config.

  The root config now declares one project per package, so each runs under its own
  `vite.config.ts` and therefore its own environment, plus an `integration`
  project for the root suite. `test:unit` and `test:integration` select by project
  name rather than by glob. Both commands now agree with `pnpm test`: 788 tests
  across 95 files, where CI had been running 20.

- [#96](https://github.com/Taylor-CCB-Group/SpatialData.js/pull/96) [`886c6f2`](https://github.com/Taylor-CCB-Group/SpatialData.js/commit/886c6f2750998aaaf39c7ca617f048ecedade3bb) Thanks [@xinaesthete](https://github.com/xinaesthete)! - `TableElement.getObsColumnNames()` no longer reports the obs index as a column.

  The index array sits alongside the columns in the `obs` group, so it was being
  offered anywhere obs columns are listed — as `_index` for tables whose index is
  unnamed (the `blobs` fixture), which is AnnData's internal storage name rather
  than anything meaningful to a user. The name is now read from the `_index`
  attribute on the `obs` group and filtered out; the new
  `TableElement.getObsIndexColumnName()` exposes it for callers that want the
  index itself, alongside the existing `loadObsIndex()`.

## 0.3.1

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

- Updated dependencies [[`e343a72`](https://github.com/Taylor-CCB-Group/SpatialData.js/commit/e343a721ce949fd9592c8ead2edec9a238f70f92)]:
  - zarrextra@0.3.0

## 0.2.5

### Patch Changes

- Updated dependencies [[`c5e6deb`](https://github.com/Taylor-CCB-Group/SpatialData.js/commit/c5e6deb3c5f621844302c80ae92603b3f70cacf3)]:
  - zarrextra@0.2.3

## 0.2.4

## 0.2.3

## 0.2.2

### Patch Changes

- Updated dependencies [[`c84758c`](https://github.com/Taylor-CCB-Group/SpatialData.js/commit/c84758c780db65737a7978231586ea7d99e1d4fb)]:
  - zarrextra@0.2.2

## 0.2.1

### Patch Changes

- Updated dependencies [[`4e58f28`](https://github.com/Taylor-CCB-Group/SpatialData.js/commit/4e58f28f585ab4e95f0057cba1b27ce75045402a)]:
  - zarrextra@0.2.1

## 0.2.0

### Minor Changes

- [#48](https://github.com/Taylor-CCB-Group/SpatialData.js/pull/48) [`e20648d`](https://github.com/Taylor-CCB-Group/SpatialData.js/commit/e20648df7ba22b869949b684ab70348978eb8774) Thanks [@xinaesthete](https://github.com/xinaesthete)! - Add support for alternative codecs in zarrextra, with tooling to encode images as JPEG2000 and HTJ2K.

  Zarrita stores can be configured to decode in workers.

### Patch Changes

- [#47](https://github.com/Taylor-CCB-Group/SpatialData.js/pull/47) [`faf55cf`](https://github.com/Taylor-CCB-Group/SpatialData.js/commit/faf55cf9988e0a82449f5dcd3b75c01aa6550587) Thanks [@xinaesthete](https://github.com/xinaesthete)! - Fix schema to allow for tables without association to spatial elements.

- Updated dependencies [[`e20648d`](https://github.com/Taylor-CCB-Group/SpatialData.js/commit/e20648df7ba22b869949b684ab70348978eb8774)]:
  - zarrextra@1.0.0

## 0.1.0

### Minor Changes

- [#42](https://github.com/Taylor-CCB-Group/SpatialData.js/pull/42) [`0a73939`](https://github.com/Taylor-CCB-Group/SpatialData.js/commit/0a73939691b44b44204842e3d408a8d1114c2212) Thanks [@xinaesthete](https://github.com/xinaesthete)! - Prepare the first MDV-targeted alpha prerelease.

### Patch Changes

- Updated dependencies [[`0a73939`](https://github.com/Taylor-CCB-Group/SpatialData.js/commit/0a73939691b44b44204842e3d408a8d1114c2212)]:
  - zarrextra@0.1.0

## 0.1.0-next.0

### Minor Changes

- [#42](https://github.com/Taylor-CCB-Group/SpatialData.js/pull/42) [`0a73939`](https://github.com/Taylor-CCB-Group/SpatialData.js/commit/0a73939691b44b44204842e3d408a8d1114c2212) Thanks [@xinaesthete](https://github.com/xinaesthete)! - Prepare the first MDV-targeted alpha prerelease.

### Patch Changes

- Updated dependencies [[`0a73939`](https://github.com/Taylor-CCB-Group/SpatialData.js/commit/0a73939691b44b44204842e3d408a8d1114c2212)]:
  - zarrextra@0.1.0-next.0
