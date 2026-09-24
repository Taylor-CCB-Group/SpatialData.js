---
'@spatialdata/core': patch
---

Bound main-thread parquet stream reads, so a stalled reader fails over instead of hanging

A refused HTTP range makes parquet-wasm panic and leave its promise unsettled, which hung
the points preload, the feature scan and the in-bounds stream with nothing logged. All
three now share the worker's silence budget (`setParquetWorkerRequestTimeout`, 30s;
`0`/`Infinity` disables) and fall back to the byte-oriented reader on expiry. The feature
scan's fallback restarts from the first row group, so a running progress total can step
backwards before climbing again.
