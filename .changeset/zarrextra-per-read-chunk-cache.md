---
"zarrextra": minor
---

`getZarrChunk(arr, selection, { cache })` takes a chunk cache per read, used in place of the one given to `enableWorkerChunkDecode`, and now also honoured on the main-thread backend. Concurrent reads through one cache share each chunk's fetch and decode. `getZarrChunk`, `ZarrGetOptions` and `ChunkCache` are exported from the package root.
