# @spatialdata/vis

## 0.2.6

### Patch Changes

- [#68](https://github.com/Taylor-CCB-Group/SpatialData.js/pull/68) [`25124c5`](https://github.com/Taylor-CCB-Group/SpatialData.js/commit/25124c50a2107a1813c3bac1ee8d48161b477422) Thanks [@xinaesthete](https://github.com/xinaesthete)! - Bump viv to 0.22.0 and deck.gl/luma.gl ecosystem to 9.3.5

- [#75](https://github.com/Taylor-CCB-Group/SpatialData.js/pull/75) [`f109b95`](https://github.com/Taylor-CCB-Group/SpatialData.js/commit/f109b95ab44a5255537c9dbd861cf2c92fee2283) Thanks [@xinaesthete](https://github.com/xinaesthete)! - Auto-select the coordinate system when a SpatialData object has exactly one. Previously the picker started unselected (showing "Select a coordinate system") even when there was only one choice, and a separate effect would eagerly pick the first of several. Now selection defaults only in the unambiguous single-coordinate-system case; multi-system datasets still require an explicit choice.

- [#69](https://github.com/Taylor-CCB-Group/SpatialData.js/pull/69) [`e343a72`](https://github.com/Taylor-CCB-Group/SpatialData.js/commit/e343a721ce949fd9592c8ead2edec9a238f70f92) Thanks [@xinaesthete](https://github.com/xinaesthete)! - Switch HTJ2K codec from `@cornerstonejs/codec-openjph` to `openjph-wasm`, which correctly round-trips multi-component (volumetric) HTJ2K data. The cornerstone build silently dropped components 2..N on decode; `openjph-wasm` handles arbitrary component counts losslessly.

  Also adds true z>1 multi-component chunk support: z-planes are now encoded as components of a single codestream rather than one plane per chunk. Exports `Htj2kPlane` from the package index.

- Updated dependencies [[`bd594e2`](https://github.com/Taylor-CCB-Group/SpatialData.js/commit/bd594e2e1efddffb4b9280d0970abd0aa84fed0e), [`e343a72`](https://github.com/Taylor-CCB-Group/SpatialData.js/commit/e343a721ce949fd9592c8ead2edec9a238f70f92)]:
  - @spatialdata/layers@0.2.6
  - zarrextra@0.3.0
  - @spatialdata/avivatorish@0.2.6
  - @spatialdata/core@0.2.6
  - @spatialdata/react@0.2.6

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
