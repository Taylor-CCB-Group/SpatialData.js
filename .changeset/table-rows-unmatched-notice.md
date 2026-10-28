---
"@spatialdata/core": minor
"@spatialdata/vis": minor
---

Shapes and labels layers now report a `table-rows-unmatched` notice through `getEntryStatus` when the associated table's `instance_key` values can't join to the element, instead of silently drawing no table colours or tooltip fields. For labels this catches ids the raster's dtype can't hold, such as packed 64-bit cell ids against a uint32 raster. `SpatialCanvas` now shows each layer's errors and notices in its layer panel, with Retry for retryable errors.
