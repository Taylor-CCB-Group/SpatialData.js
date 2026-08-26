---
'@spatialdata/core': minor
---

Stream the progressive points preload in the parquet worker

A points layer coloured by feature took its preload through
`streamPointsWithFeaturesByUrl`, which drives parquet-wasm's `ParquetFile.stream()`
and `tableFromIPC` **on the main thread** — from above the worker gate, so enabling
the parquet worker made no difference to it.

Measured in the docs demo on a 4.83M-row Xenium transcripts element with a
12,448-feature panel, capped at 4M rows:

| | before | after |
| --- | --- | --- |
| worker requests | **zero** | 62 batches, 4M rows |
| preload completes | **never** (9.4 min, still going) | 75 s |
| worst single task | 113 s / 93 s / 90 s | ~4.2 s |
| long tasks to that point | 543 s and climbing | 63 s |

The same stream now runs end to end in the worker: it range-fetches each part itself
and posts batches back as it decodes them, so the progressive coloured paint is
preserved while the main thread only copies each batch into its accumulator. The
main-thread stream stays as the fallback for hosts without a worker bundle, and for a
stream that fails part way through.

Necessary but not sufficient for that dataset: the feature column is a dictionary, so
batch one already names all 12,448 features, and every progress tick then re-renders
the unvirtualized feature list of #172, which dominates what is left.

This needed the worker protocol to carry more than one message per request:

- `ParquetWorkerMessage` gains a `direction: 'stream'` interim variant alongside the
  terminal `response`. Interim messages do not settle the request.
- The per-request timeout (`setParquetWorkerRequestTimeout`) now measures time since
  the **last message** rather than time to the only response. Unchanged for
  request/response types, where exactly one message ever arrives; without it a
  minutes-long stream would look stuck.
- A new `cancelParquetStream` request stops the worker *fetching* when a load is
  superseded or the client gives up, not just the client listening.

A stream that fails after delivering batches rejects rather than reporting a partial
as success — nothing downstream can tell a truncated preload from a complete one —
and the caller restarts on the main thread.
