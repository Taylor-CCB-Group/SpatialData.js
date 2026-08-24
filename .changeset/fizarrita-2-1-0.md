---
'zarrextra': minor
---

Move to `@fideus-labs/fizarrita` and `@fideus-labs/worker-pool` 2.1.0.

A major bump upstream, but a no-op at this seam: the pieces `zarrextra` touches —
`getWorker`, `ChunkCache`, `GetWorkerOptions`, the codec-worker entry — are
unchanged in shape. What moved is internal to fizarrita (`createDefaultWorker`
relocating to a `create-worker` module, a `WorkerLike` abstraction so the pool can
run on `node:worker_threads`), and all of it is still exported from the package
root we import from. Nothing here needed editing to compile.

What we get for it is the whole of what ADR 0005 recorded as owed upstream:

- **Concurrent readers of one chunk now share a single fetch and decode.**
  fizarrita keys in-flight operations the same way it keys the chunk cache, so
  the window between "someone started fetching this" and "the result is
  cacheable" no longer costs a duplicate round-trip and a duplicate decompression.
  This is what makes the chunk cache worth its bytes on a pan that re-enters
  ground already in flight.
- **Metadata reads and the chunk-shape probe are memoised per `(store, path)`.**
  Every `getWorker` call used to re-read `zarr.json`/`.zarray` and re-run
  `probeActualChunkShape`, *before* the cache was consulted — so a populated
  chunk cache could not eliminate them and every tile paid for both.
- **Codec classification no longer mistakes compressed chunks for uncompressed
  ones.** The old check named the compressors it knew; anything else — JPEG 2000
  and HTJ2K among them — took the not-compressed branch and reported its
  *compressed* length as its decompressed size, feeding a wrong number to chunk
  shape inference. It now allowlists the codecs that preserve byte count instead.
  This one affects our imagery directly.
- **`getWorker` accepts an `AbortSignal`**, forwarded to every `store.get`.
  Not taken up here yet — `rejectOnAbort` still only settles the promise early,
  so a cancelled read stops being awaited while its fetch and decode run on.
  Wiring it through is now possible and is deliberately left as its own change.
