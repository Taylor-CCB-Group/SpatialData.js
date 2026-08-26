---
'@spatialdata/core': minor
---

Stream the progressive points preload in the parquet worker

A points layer coloured by feature took its preload through
`streamPointsWithFeaturesByUrl`, which drives parquet-wasm's `ParquetFile.stream()`
and `tableFromIPC` **on the main thread** — and did so from above the worker gate, so
enabling the parquet worker made no difference to it. On a 4M-row Xenium transcripts
element that is five ~700ms decodes and ~4.4s of long tasks on a small panel, and
tens of seconds of them on a wide one, with zero requests reaching the worker.

The same stream now runs end to end in the worker: it range-fetches each part
itself and posts batches back as it decodes them, so the progressive coloured paint
is preserved while the main thread only copies each batch into its accumulator. The
main-thread stream stays as the fallback for hosts that have not wired a worker
bundle, and for a stream that fails part way through.

This needed the worker protocol to carry more than one message per request, which is
new:

- `ParquetWorkerMessage` gains a `direction: 'stream'` interim variant, alongside the
  terminal `response` every request type already posts. Interim messages do not
  settle the request.
- The per-request timeout (`setParquetWorkerRequestTimeout`) now measures time since
  the **last message** rather than time to the only response. Unchanged for
  request/response types, where exactly one message ever arrives; without it a
  minutes-long stream would look stuck.
- A new `cancelParquetStream` request stops the worker fetching when a load is
  superseded or the client gives up, instead of only stopping the client listening.

A stream that fails after delivering batches rejects rather than reporting a partial
as success — nothing downstream can tell a truncated preload from a complete one —
and the caller restarts on the main thread.
