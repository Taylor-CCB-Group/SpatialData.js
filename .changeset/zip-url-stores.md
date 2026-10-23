---
"zarrextra": minor
"@spatialdata/core": patch
---

`readZarr`, `openExtraConsolidated` and `SpatialDataProvider` open a URL whose path ends in `.zip` as a zipped store, read by range rather than downloaded; the server must honour `Range`. `isZipUrl(url)` reports which URLs this applies to.
