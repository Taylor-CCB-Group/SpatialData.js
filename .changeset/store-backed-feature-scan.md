---
"@spatialdata/core": patch
---

`listFeatures()` on a large points element now works when the store has no URL, such as a zarrextra `ZipStore` or `FolderStore`. It reads only the feature columns, one batch at a time, through the store. Before, it fell back to decoding the whole parquet file, which ran parquet-wasm out of memory (`RuntimeError: unreachable`) on files of a few hundred MB.
