---
"zarrextra": minor
"@spatialdata/vis": patch
---

`ZipStore.open(source)` opens a zipped zarr store from a URL, `Blob`/`File` or byte reader, and `FolderStore.fromFiles(files)` opens a folder picked with `<input webkitdirectory>`; pass either to `openExtraConsolidated` or `readZarr`. `ZipStore.entrySize(key)` lets a STORED zip nested in another be opened without extracting it. Stores without consolidated metadata are listed from their files, and zip URLs need a server that honours `Range`. The `Sketch` demo can open a local zip or folder.

`ImageView` is deprecated; use `SpatialCanvas` with an image layer.
