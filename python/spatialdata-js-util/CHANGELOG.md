# spatialdata-js-util

## 0.3.0

### Minor Changes

- [#276](https://github.com/Taylor-CCB-Group/SpatialData.js/pull/276) [`bb699f1`](https://github.com/Taylor-CCB-Group/SpatialData.js/commit/bb699f10967e28379786c520d029efdc6bd48b2a) Thanks [@xinaesthete](https://github.com/xinaesthete)! - New `write_spatialdata(sdata, path)` writes a `SpatialData` like `sdata.write` but copies points elements that are unchanged since reading as files, instead of re-encoding every partition through dask (tens of GB of RAM on transcript-scale points), and writes nullable string columns on AnnData versions that refuse them. `recompress_spatialdata` now uses it for an in-memory source, writes straight to the destination rather than copying the store twice, and takes `temp_dir` to put its intermediate copies somewhere other than the system temp directory.
  
  Also new: `zip_directory(source, zip_path)` and `spatialdata-js-util zip SOURCE ZIP` pack a store into the uncompressed zip that `zarrextra`'s `ZipStore` range-reads; and `remove_tree`, which the package now uses instead of `shutil.rmtree`, so deleting a directory on an exFAT volume under macOS no longer fails when `._*` sidecar files vanish mid-walk.

## 0.2.0

### Minor Changes

- [#240](https://github.com/Taylor-CCB-Group/SpatialData.js/pull/240) [`e841339`](https://github.com/Taylor-CCB-Group/SpatialData.js/commit/e84133978c5cbdc2376c085d17dc3903b26ded23) Thanks [@xinaesthete](https://github.com/xinaesthete)! - `ensure_pyramids(sdata)` gives the raster elements of an in-memory `SpatialData` the overview levels they lack, without writing or recompressing anything, so a caller about to `sdata.write()` pays for no extra copies. `add_pyramids_in_place(store)` (CLI: `images add-pyramid STORE --in-place`) does the same to an existing store, appending new level arrays beside the old ones instead of copying the store; levels it adds use plain zarr codecs, never an image codec.
  
  Behaviour change: `add_pyramids`, `images add-pyramid` and `recompress_spatialdata(pyramid=True)` now give levels to any element whose coarsest level is larger than `min_size` (or, with an explicit level count, that has fewer levels than asked for), instead of skipping every element with more than one level. Existing levels are kept and new ones are coarsened from the coarsest; such elements report `action: "extended"` (a single-resolution element now reports `"extended"` rather than `"rebuilt"`). `force` still rebuilds every element from full resolution and reports `"rebuilt"`. Skipped elements report a new `reason`.

### Patch Changes

- [#249](https://github.com/Taylor-CCB-Group/SpatialData.js/pull/249) [`13633fe`](https://github.com/Taylor-CCB-Group/SpatialData.js/commit/13633fec2059c58cbc42f62dc4e425c22ccd4ec3) Thanks [@xinaesthete](https://github.com/xinaesthete)! - Require `imagecodecs>=2026.6.26`, the first release with HTJ2K in its wheels for every platform. With an older `imagecodecs` kept by a lockfile, HTJ2K encoding silently needed Node.js; falling back to the Node-based encoder now also emits a `RuntimeWarning`.
