---
"@spatialdata/core": patch
---

Correct the comment on the progressive points preload, which claimed it "needs no
worker: the per-batch work is a dictionary lookup and a typed-array copy".

It is not. `streamPointsWithFeaturesByUrl` drives parquet-wasm's `ParquetFile` and
`tableFromIPC` itself, on the main thread, and it is tried *before* the
`isParquetWorkerEnabled()` gate — so on any element with a feature key and a progress
callback (the normal case for a coloured points layer) the whole preload decodes on
the main thread and the parquet worker never sees it.

Measured on a 4M-row capped preload of a five-part Xenium transcripts element: five
~700ms decodes, ~4.4s of long tasks, and zero `decodeParquetGeometryCapped` requests
posted. Behaviour is unchanged here — this has been the shape since #89 — but the
comment actively misled anyone looking for why enabling the worker does not stop a
points layer blocking.
