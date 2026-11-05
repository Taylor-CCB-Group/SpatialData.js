---
"spatialdata-js-util": minor
---

New `write_spatialdata(sdata, path)` writes a `SpatialData` like `sdata.write` but copies points elements that are unchanged since reading as files, instead of re-encoding every partition through dask (tens of GB of RAM on transcript-scale points), and writes nullable string columns on AnnData versions that refuse them. `recompress_spatialdata` now uses it for an in-memory source, writes straight to the destination rather than copying the store twice, and takes `temp_dir` to put its intermediate copies somewhere other than the system temp directory.

Also new: `zip_directory(source, zip_path)` and `spatialdata-js-util zip SOURCE ZIP` pack a store into the uncompressed zip that `zarrextra`'s `ZipStore` range-reads; and `remove_tree`, which the package now uses instead of `shutil.rmtree`, so deleting a directory on an exFAT volume under macOS no longer fails when `._*` sidecar files vanish mid-walk.
