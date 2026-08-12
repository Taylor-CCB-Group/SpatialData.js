---
'@spatialdata/core': minor
'@spatialdata/vis': minor
---

Report a failed feature-index scan instead of going quiet.

`getMatchingLoadState` returned `undefined` for a failed `matching` slot — exactly
what it returns for "no scan has ever run" — and nothing else exposed the error. So
a scan that failed looked identical to one that had not started, while the render
path carried on filtering the resident batch. The panel showed whichever part of the
selection happened to be inside the memory cap and presented it as the complete
answer.

`PointsMatchingLoadState` gains `failed` and `error`, reported for the selection the
failed scan would have covered (and only that one — a stale failure for a selection
the user has since changed is not attributed to the new one, and a retained good
batch no longer masks it). `usePointsFeatureState` gains `retryFailedLoads`, and the
built-in feature filter panel now says the load failed, says the canvas is showing
only what was already in memory, and offers Retry when the error is retryable.
