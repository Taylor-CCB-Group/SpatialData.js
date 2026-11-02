---
"@spatialdata/core": minor
"@spatialdata/vis": minor
---

Elements report how they are stored when that will be slow: `element.getIssues()` (synchronous, from consolidated metadata) returns structured `ElementIssue`s, each with a `remedy` describing the fix. Images and labels flag a missing or too-shallow pyramid and oversized chunks (thresholds exported as `COARSEST_LEVEL_PIXEL_BUDGET` and `CHUNK_DECODED_BYTES_BUDGET`). Resolvers surface them as an `element-issues` entry notice.
