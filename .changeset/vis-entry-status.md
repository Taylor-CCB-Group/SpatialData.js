---
"@spatialdata/vis": minor
---

The renderer hooks report why each layer failed and what is degraded about it: `getEntryStatus(layerId)` returns its typed `SpatialEntryError`s and `EntryNotice`s, `onEntryStatusChange` calls back when that changes, and `retryEntry(layerId)` re-runs failed loads. A stack entry whose element is missing, or has no transform to the coordinate system, now reports `element-not-found` or `coordinate-system-not-found` instead of being silently skipped.
