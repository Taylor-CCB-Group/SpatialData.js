---
'@spatialdata/core': patch
---

Bound main-thread parquet stream reads, so a stalled reader fails over instead of hanging

A refused HTTP range left the points preload, the feature scan and the in-bounds stream
awaiting a promise that never settles. All three now expire on the worker's silence budget
(`setParquetWorkerRequestTimeout`, 30s) and fall back to the byte-oriented reader. The
feature scan's fallback restarts from the first row group, so a running progress total can
step backwards before climbing again.
