# @spatialdata/layers

## 0.2.6

### Patch Changes

- [#71](https://github.com/Taylor-CCB-Group/SpatialData.js/pull/71) [`bd594e2`](https://github.com/Taylor-CCB-Group/SpatialData.js/commit/bd594e2e1efddffb4b9280d0970abd0aa84fed0e) Thanks [@xinaesthete](https://github.com/xinaesthete)! - Fix multiscale labels rendering with an obviously wrong (vertically stretched, mis-placed) transformation when zoomed out past the coarsest resolution level.

  The `MultiscaleLabelsTileLayer` was configured with `minZoom: -20`, so deck.gl kept subdividing the tile grid below the deepest available resolution level. Past that level `getTileData` clamps to the deepest loader and returns the same data, but the tile bbox keeps doubling — so the bounds formula stretched that fixed data across an ever-larger world rect, far beyond the image extent. `minZoom` is now capped at `-(loader.length - 1)`, matching Viv's `MultiscaleImageLayer`, so the coarsest real tiles stay correctly placed at any zoom-out.

  Also adds the bbox-culling guards Viv's `renderSubLayers` applies (skip tiles with negative bbox edges or zero-sized data) for defense in depth. This is the underlying cause that [#44](https://github.com/Taylor-CCB-Group/SpatialData.js/issues/44) only masked by making sublayer ids unique.

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
