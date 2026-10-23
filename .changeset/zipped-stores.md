---
"zarrextra": minor
"@spatialdata/vis": patch
---

`ZipStore.open(source)` opens a zipped zarr store from a URL, `Blob`/`File` or byte reader, and `FolderStore.fromFiles(files)` opens a folder picked with `<input webkitdirectory>`; pass either to `openExtraConsolidated` or `readZarr`. Stores without consolidated metadata are listed from their files, and zip URLs need a server that honours `Range`. The `Sketch` demo can open a local zip or folder.
