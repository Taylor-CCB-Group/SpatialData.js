# spatialdata-js-util

## 0.2.0

### Minor Changes

- [#240](https://github.com/Taylor-CCB-Group/SpatialData.js/pull/240) [`e841339`](https://github.com/Taylor-CCB-Group/SpatialData.js/commit/e84133978c5cbdc2376c085d17dc3903b26ded23) Thanks [@xinaesthete](https://github.com/xinaesthete)! - `ensure_pyramids(sdata)` gives the raster elements of an in-memory `SpatialData` the overview levels they lack, without writing or recompressing anything, so a caller about to `sdata.write()` pays for no extra copies. `add_pyramids_in_place(store)` (CLI: `images add-pyramid STORE --in-place`) does the same to an existing store, appending new level arrays beside the old ones instead of copying the store; levels it adds use plain zarr codecs, never an image codec.
  
  Behaviour change: `add_pyramids`, `images add-pyramid` and `recompress_spatialdata(pyramid=True)` now give levels to any element whose coarsest level is larger than `min_size` (or, with an explicit level count, that has fewer levels than asked for), instead of skipping every element with more than one level. Existing levels are kept and new ones are coarsened from the coarsest; such elements report `action: "extended"` (a single-resolution element now reports `"extended"` rather than `"rebuilt"`). `force` still rebuilds every element from full resolution and reports `"rebuilt"`. Skipped elements report a new `reason`.

### Patch Changes

- [#249](https://github.com/Taylor-CCB-Group/SpatialData.js/pull/249) [`13633fe`](https://github.com/Taylor-CCB-Group/SpatialData.js/commit/13633fec2059c58cbc42f62dc4e425c22ccd4ec3) Thanks [@xinaesthete](https://github.com/xinaesthete)! - Require `imagecodecs>=2026.6.26`, the first release with HTJ2K in its wheels for every platform. With an older `imagecodecs` kept by a lockfile, HTJ2K encoding silently needed Node.js; falling back to the Node-based encoder now also emits a `RuntimeWarning`.
