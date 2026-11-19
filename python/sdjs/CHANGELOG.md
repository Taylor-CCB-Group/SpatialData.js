# sdjs

## 0.2.0

### Minor Changes

- [#307](https://github.com/Taylor-CCB-Group/SpatialData.js/pull/307) [`de552a4`](https://github.com/Taylor-CCB-Group/SpatialData.js/commit/de552a4d741002a2aac110086c5898092a607843) Thanks [@xinaesthete](https://github.com/xinaesthete)! - The viewer keeps your layers when you switch stores in the picker, so runs with the same element names open with the same setup. Layers whose element a store lacks are marked unavailable and come back when you switch to a store that has them.

## 0.1.0

### Minor Changes

- [#294](https://github.com/Taylor-CCB-Group/SpatialData.js/pull/294) [`996fde6`](https://github.com/Taylor-CCB-Group/SpatialData.js/commit/996fde69a2060df4eea5beae30bb5225ec30d262) Thanks [@xinaesthete](https://github.com/xinaesthete)! - New `sdjs serve [root]` (`npx @spatialdata/cli serve` or `uvx sdjs serve`) serves every `*.zarr` and `*.zarr.zip` store under a directory on loopback and opens them in the bundled viewer, with a picker that greys out stores that are not SpatialData.
