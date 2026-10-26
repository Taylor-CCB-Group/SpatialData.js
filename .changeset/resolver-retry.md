---
"@spatialdata/core": minor
---

`SpatialEntryStore.retry(ctx)` re-runs an entry's failed resources. `ResourceResolver` gains a required `retry(elementKey)`, so a custom resolver must implement it: make its failed resources plannable again, since `plan()` should not reschedule a failure by itself.
