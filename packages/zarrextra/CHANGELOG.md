# zarrextra

## 0.4.0

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

- [#107](https://github.com/Taylor-CCB-Group/SpatialData.js/pull/107) [`423448b`](https://github.com/Taylor-CCB-Group/SpatialData.js/commit/423448b13e6a2cb07324faa9b318dca2c6ba1c59) Thanks [@xinaesthete](https://github.com/xinaesthete)! - Remove the unused `zarrSchema` module and drop `zod` from the package's dependencies.

  The v2 `.zarray` / v3 `zarr.json` schemas were never exported, so no public API changes. Array metadata stays unvalidated on the tree by design: `zarrita` validates on the real read path, and `getArrayDtype` already reconciles both generations' dtype spellings.

## 0.3.0

### Minor Changes

- [#69](https://github.com/Taylor-CCB-Group/SpatialData.js/pull/69) [`e343a72`](https://github.com/Taylor-CCB-Group/SpatialData.js/commit/e343a721ce949fd9592c8ead2edec9a238f70f92) Thanks [@xinaesthete](https://github.com/xinaesthete)! - Switch HTJ2K codec from `@cornerstonejs/codec-openjph` to `openjph-wasm`, which correctly round-trips multi-component (volumetric) HTJ2K data. The cornerstone build silently dropped components 2..N on decode; `openjph-wasm` handles arbitrary component counts losslessly.

  Also adds true z>1 multi-component chunk support: z-planes are now encoded as components of a single codestream rather than one plane per chunk. Exports `Htj2kPlane` from the package index.

## 0.2.3

### Patch Changes

- [#63](https://github.com/Taylor-CCB-Group/SpatialData.js/pull/63) [`c5e6deb`](https://github.com/Taylor-CCB-Group/SpatialData.js/commit/c5e6deb3c5f621844302c80ae92603b3f70cacf3) Thanks [@xinaesthete](https://github.com/xinaesthete)! - Chunk worker enabled by default in vis, and hopefully resolve some bundling issues.

## 0.2.2

### Patch Changes

- [#54](https://github.com/Taylor-CCB-Group/SpatialData.js/pull/54) [`c84758c`](https://github.com/Taylor-CCB-Group/SpatialData.js/commit/c84758c780db65737a7978231586ea7d99e1d4fb) Thanks [@xinaesthete](https://github.com/xinaesthete)! - Build the codec worker as a self-contained artifact for Vite consumers.

## 0.2.1

### Patch Changes

- [#52](https://github.com/Taylor-CCB-Group/SpatialData.js/pull/52) [`4e58f28`](https://github.com/Taylor-CCB-Group/SpatialData.js/commit/4e58f28f585ab4e95f0057cba1b27ce75045402a) Thanks [@xinaesthete](https://github.com/xinaesthete)! - Fix codec worker in published version (🤞)

## 1.0.0

### Major Changes

- [#48](https://github.com/Taylor-CCB-Group/SpatialData.js/pull/48) [`e20648d`](https://github.com/Taylor-CCB-Group/SpatialData.js/commit/e20648df7ba22b869949b684ab70348978eb8774) Thanks [@xinaesthete](https://github.com/xinaesthete)! - Add support for alternative codecs in zarrextra, with tooling to encode images as JPEG2000 and HTJ2K.

  Zarrita stores can be configured to decode in workers.

## 0.1.0

### Minor Changes

- [#42](https://github.com/Taylor-CCB-Group/SpatialData.js/pull/42) [`0a73939`](https://github.com/Taylor-CCB-Group/SpatialData.js/commit/0a73939691b44b44204842e3d408a8d1114c2212) Thanks [@xinaesthete](https://github.com/xinaesthete)! - Prepare the first MDV-targeted alpha prerelease.

## 0.1.0-next.0

### Minor Changes

- [#42](https://github.com/Taylor-CCB-Group/SpatialData.js/pull/42) [`0a73939`](https://github.com/Taylor-CCB-Group/SpatialData.js/commit/0a73939691b44b44204842e3d408a8d1114c2212) Thanks [@xinaesthete](https://github.com/xinaesthete)! - Prepare the first MDV-targeted alpha prerelease.
