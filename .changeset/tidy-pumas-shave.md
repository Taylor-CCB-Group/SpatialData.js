---
'@spatialdata/core': patch
---

`TableElement.getObsColumnNames()` no longer reports the obs index as a column.

The index array sits alongside the columns in the `obs` group, so it was being
offered anywhere obs columns are listed — as `_index` for tables whose index is
unnamed (the `blobs` fixture), which is AnnData's internal storage name rather
than anything meaningful to a user. The name is now read from the `_index`
attribute on the `obs` group and filtered out; the new
`TableElement.getObsIndexColumnName()` exposes it for callers that want the
index itself, alongside the existing `loadObsIndex()`.
