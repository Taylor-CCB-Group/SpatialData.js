---
"@spatialdata/core": patch
"@spatialdata/layers": patch
"@spatialdata/vis": patch
---

Points: feature selection now works on large elements, and persists by name.

**Selections persist as feature names.** `PointsLayerConfig.featureNames` is the
durable, serializable form and what the UI writes. Codes are app-assigned for a
dictionary-only element (a Xenium `transcripts` has `feature_name` and no code
column), so a stored code could silently come back meaning a different feature.
`featureCodes` still works and still takes effect at runtime, but names win when
both are present. `resolveFeatureSelectionCodes` / `featureNamesForCodes` are
exported from `@spatialdata/core` for converting between the two.

**The feature scan now completes on large elements.** Previously, selecting a
feature on a multi-million-row element frequently never resolved — the scan
plateaued part-way through and the layer sat there. It now reads through
`ParquetFile.stream({ columns, rowGroups })`, which fetches per column chunk, so
the projection reaches the network instead of pulling whole row groups — all 12
columns of a Xenium `transcripts` to use three. The scan runs in the points
worker, keeping the parquet decode off the main thread. Selecting one gene from a 12.1M-row element now
settles in ~1.0s, with main-thread time roughly a third of what the pre-streaming
path cost.

Also fixed along the way: a full-dataset catalog scan being silently cancelled by
the resident preview settling underneath it (leaving counts stuck and colours
mismatched); row-group chunks handing out the cached footer buffer, which the
worker transfer detached (`DataCloneError`, dropping the element onto whole-file
reads); parquet part layout being re-probed on every call; a server that answers
a directory path with 500 rather than 404 wedging part traversal; and point size
not accounting for an element's transform scale.

Known limitation: for a dictionary-only element the fallback catalog path cannot
tally per-feature counts, and it settles *successfully* without them — so the
retry path does not repair it and counts stay absent for the session. Names and
selection are unaffected. Treat a missing count as unknown, not zero, and do not
read the presence of counts as a signal that the scan completed.
