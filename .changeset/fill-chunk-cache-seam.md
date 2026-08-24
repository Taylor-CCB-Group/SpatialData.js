---
'@spatialdata/vis': minor
'@spatialdata/core': patch
---

Give zarr imagery a decoded chunk cache
([ADR 0005](https://github.com/Taylor-CCB-Group/SpatialData.js/blob/main/docs/adr/0005-memory-accounting-before-management.md)
rung 3). There was not one before — not an undersized one, none at all.

fizarrita has always accepted a `{ get, set }` cache on `getWorker`, and
`zarrextra` has always plumbed it through `enableWorkerChunkDecode({ cache })`.
`ensureCodecWorkers()` called that with no options, so `cache` was `undefined`
and fizarrita fell back to its no-op. The seam was exported, documented, typed
end to end, and empty. Every tile therefore paid a network round-trip *and* a
re-decode every time it came back into view.

It is now filled with a byte-bounded LRU, default 256 MB, overridable with
`ensureCodecWorkers({ chunkCacheMaxBytes })` on the first call. `getChunkCache()`
returns it for inspection (`byteLength` is what it currently holds) or for
`clear()`.

`RasterElement.getStore()` is now memoized, and that is load-bearing rather than
tidiness: fizarrita keys chunks as `store_N:{array path}:{chunk key}`, where `N`
comes from a `WeakMap` on the **store instance**, and `createPrefixedStore`
returns a fresh object literal on every call. Handing out a new view per caller
would give one chunk a different key per view, so the cache would fill with
duplicates and never hit. One stable view per element is what makes it a cache.

Two things worth stating plainly about what ends up in there:

- **Absent chunks are cached as data.** fizarrita materialises a full zero-filled
  typed array for a missing chunk and caches it like any other, so a sparse array
  can spend real bytes on nothing. The byte bound makes that survivable; it does
  not make it free.
- **Concurrent readers of one chunk share a single fetch and decode.** fizarrita
  keys in-flight operations the same way it keys this cache, closing the window
  between "someone started fetching this" and "the result is cacheable". So the
  cache sees one write per chunk however many readers wanted it, and the byte
  total counts each chunk once.
