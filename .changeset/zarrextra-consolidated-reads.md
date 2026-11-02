---
'@spatialdata/zarrextra': patch
---

`openExtraConsolidated` reads each node's attributes and metadata from the store's consolidated metadata instead of opening every node, and picks `zarr.json` or `.zarray`/`.zgroup` once from the store root. A consolidated v2 store no longer sends a 404 for `zarr.json` per node.
