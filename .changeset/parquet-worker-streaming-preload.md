---
'@spatialdata/core': minor
---

Stream the progressive points preload in the parquet worker

A points layer coloured by feature ran its preload through
`streamPointsWithFeaturesByUrl` — parquet-wasm's `ParquetFile.stream()` and
`tableFromIPC` **on the main thread**, from above the worker gate, so enabling the
parquet worker made no difference to it. It now range-fetches and decodes in the
worker, posting batches back as they land, so the progressive coloured paint survives
while the main thread only copies each batch into its accumulator.

Docs demo, 4.83M-row Xenium transcripts element with a 12,448-feature panel, capped at
4M rows:

| | before | after |
| --- | --- | --- |
| worker requests | **zero** | 62 batches, 4M rows |
| preload completes | **never** (9.4 min, still going) | 75 s |
| worst single task | 113 s | ~4.2 s |
| long tasks to that point | 543 s and climbing | 63 s |

Not sufficient on its own: the dictionary feature column names all 12,448 features in
batch one, so every progress tick re-renders the unvirtualized feature list of #172,
which dominates what is left.

New in the worker protocol, which now carries more than one message per request:

- `ParquetWorkerMessage` gains a `direction: 'stream'` interim variant alongside the
  terminal `response`. Interim messages do not settle the request.
- `setParquetWorkerRequestTimeout` now measures time since the **last message**, not
  time to the only response — unchanged for request/response types, where one message
  ever arrives, but without it a minutes-long stream looks stuck.
- A new `cancelParquetStream` request stops the worker *fetching*, not just the client
  listening.

The main-thread stream stays as the fallback for hosts without a worker bundle. A
stream that fails after delivering batches rejects rather than reporting a partial as
success — nothing downstream can tell a truncated preload from a complete one — and
the caller restarts there from row 0.
