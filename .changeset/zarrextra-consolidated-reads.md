---
'@spatialdata/zarrextra': patch
---

`openExtraConsolidated` builds its tree from the store's consolidated metadata document with no per-node reads. A consolidated v2 store no longer sends a 404 for `zarr.json` per node. `zarr.json` is preferred over `.zmetadata` where a store has both.
