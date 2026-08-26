---
"@spatialdata/core": patch
---

Correct the comment on the progressive points preload, which claimed it "needs no
worker: the per-batch work is a dictionary lookup and a typed-array copy".

It is not. `streamPointsWithFeaturesByUrl` drives parquet-wasm's `ParquetFile` and
`tableFromIPC` itself, on the main thread, and it is tried *before* the
`isParquetWorkerEnabled()` gate.

Scope matters here: that path is only taken where the store can serve streaming range
reads. Where it cannot, the method bails and the worker path runs as normal. So the
claim is not "points never use the worker" — it is that on a streaming-capable store,
an element with a feature key and a progress callback (the normal case for a coloured
points layer) decodes its whole preload on the main thread, worker enabled or not.

Measured on a 4M-row capped preload of a five-part Xenium transcripts element: five
~700ms decodes, ~4.4s of long tasks, and zero `decodeParquetGeometryCapped` requests
posted. Behaviour is unchanged here — this has been the shape since #89 — but the
comment actively misled anyone looking for why enabling the worker does not stop a
points layer blocking.
