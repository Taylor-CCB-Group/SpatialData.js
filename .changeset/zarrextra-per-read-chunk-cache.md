---
"zarrextra": minor
---

`getZarrChunk(arr, selection, { cache })` takes a chunk cache per read, used in place of the one given to `enableWorkerChunkDecode`; the main-thread backend still caches nothing. `getZarrChunk`, `ZarrGetOptions` and `ChunkCache` are exported from the package root.
