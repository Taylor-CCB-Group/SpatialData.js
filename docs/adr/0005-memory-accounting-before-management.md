# Memory Accounting Before Memory Management

**Status:** proposed
**Related:** [ADR 0004](0004-resource-resolver-owned-by-core.md), [ADR 0002](0002-spatially-aware-vector-loading.md)

Adopt byte-level **memory accounting** now; adopt a **Resource Ceiling** only when
measurement justifies it. Land the three rungs that fix things demonstrably broken
today; defer the architecture for a problem we have not yet measured.

## Context

SpatialData.ts has a memory *policy* and no memory *accounting*.

`DEFAULT_POINTS_MEMORY_CAP` is **4,000,000 rows** — a row count, not a byte count,
applied to one element kind. Nothing anywhere measures what is actually resident.
Grepping `packages/*/src` for `lru | evict | maxBytes | memoryBudget | memoryLimit`
returns exactly one hit outside a comment: `PointsDataEngine.evict()`, which is
keyed on **element unload**, not memory pressure. That is the entire eviction
machinery in the repository.

### The two ingest paths have the same two-tier shape, and neither is managed

|  | **Encoded tier** (compressed bytes) | **Decoded tier** (typed arrays / Arrow) |
|---|---|---|
| **zarr** (images, labels) | *nothing exists* | fizarrita's `ChunkCache` seam — **empty** |
| **parquet** (points, shapes) | `parquetTableBytes` — **unbounded, never evicted** | `parquetTableCache` — **unbounded, never evicted** |

Parquet holds **both** tiers for the same file, simultaneously, forever: double
memory, zero eviction benefit. Zarr holds **neither**, so every tile pays a network
round-trip *and* a re-decode.

### fizarrita has no cache

Its contract is the whole of:

```ts
interface ChunkCache {
  get(key: string): Chunk<DataType> | undefined
  set(key: string, value: Chunk<DataType>): void
}
```

No `delete`, no `size`, no `clear`. It can insert and look up; it can never evict,
enumerate, or measure. And `ensureCodecWorkers()` calls `enableWorkerChunkDecode()`
with **no options**, so `cache` is `undefined` and fizarrita falls back to its
`NULL_CACHE` no-op. We use fizarrita purely as **codec offload** — getting
OpenJPH/OpenJPEG WASM off the main thread. The cache is plumbed through the types
end to end and nothing ever passes one.

The seam is real, exported, documented, and free: `enableWorkerChunkDecode({ cache })`
will accept any `{get, set}` object today with no changes to fizarrita or
`zarrextra`.

### Prior art: `tgpu-htj2k`

```ts
/** Anything holding resident host memory can report it in bytes (mirrors TypedArray). */
export interface MemoryReporting {
  readonly byteLength: number;
}
```

One number, named so it **structurally matches `TypedArray`** — every typed array
satisfies it for free, with no import. That ergonomic trick is the whole design.

Two things to inherit carefully:

- Over there it is **purely observational**. Every read ends in a HUD string. The
  one place bytes drive behaviour (`TileCache.set`'s eviction loop) takes bytes as
  a *parameter*, not from the interface. **The interface and the enforcement are
  disconnected.** We should not inherit that: whatever we bound, bound it *through*
  the numbers we report.
- **A scalar cannot express tiers.** They get away with it because only the GPU
  tier is theirs (zarrita owns the compressed tier; the decoded tier is transient,
  dropped after upload). SpatialData.ts owns **all** the tiers, plus a worker heap
  a synchronous getter cannot see.

Their `TileCache<V>` — ~100 lines, framework-free, byte-bounded LRU, generic over
payload, with a `dispose` hook — is directly reusable.

## Decision

Adopt in rungs. **Land 1–3. Do not build 4–5 until measurement justifies them.**

### 1. Adopt `MemoryReporting` — the scalar only

`{ readonly byteLength: number }`. No policy, no eviction, no tiers. Just the
ability to answer *"how many bytes am I holding?"* This is the one thing that
cannot be over-engineered, and everything below is gated on it.

### 2. Bound the two caches that are already unbounded

Byte-bounded LRU over `parquetTableBytes` and `parquetTableCache`. This is
**fixing a leak, not building an architecture**.

Fix in the same pass: `parquetTableCache` stores the promise *before* it settles —
correct, genuine in-flight dedup — but never cleans up a rejection, so a single
transient fetch failure caches a rejected promise for that path **permanently**.

### 3. Fill the empty chunk-cache seam

`enableWorkerChunkDecode({ cache })` with a byte-bounded LRU. This is a **pure win
today**: there is currently no chunk cache at all, so every tile re-fetches and
re-decodes.

---

> **Stop here until measurement says otherwise.**

---

### 4. *(deferred)* Encoded tier; evict-decoded-keep-encoded

Hold compressed bytes, drop decoded payloads, re-decode on demand.

- **Viable on zarr.** Decode is already on the worker pool; encoded HTJ2K is
  roughly 10–50× smaller than the decoded typed array. The trade converts a
  network round-trip into a worker task. Note it *requires* adding the encoded
  tier first — today, evicting a decoded chunk costs a refetch, because nothing
  caches encoded bytes above the store.
- **Dangerous on parquet.** `readParquet` + `tableFromIPC` run **synchronously on
  the main thread** for shapes and for every `loadParquetTable` call. Evicting a
  decoded table costs a whole-file main-thread WASM decode to restore — that *is*
  the jank. Gated on moving shapes decode onto the worker, and on caching at
  **row-group** rather than whole-file granularity (the machinery already exists:
  `readParquetRowGroupBytesByGroupIndex`).

### 5. *(deferred)* Tiered `ResidencyReport`, a global Resource Ceiling, degrade-to-fit

Do not build the tier breakdown until something needs to **act** on the difference
between tiers — which is rung 4. Do not build a ceiling until a real OOM can be
provoked.

## Rationale for deferring 4–5

`tgpu-htj2k` **built and unit-tested** `selectWithinBudget` — a degrade-to-fit
ceiling — and then **never called it in production**. Its ADR-0010 defers it
*"until an actual OOM (e.g. a grazing oblique strip) can be provoked"*, because
the geometry (Nyquist + frustum + LOD gradient) already bounds the working set to
roughly screen size. The budget is for a pathological case they have not hit.

That is the discipline, in writing, from the people who would most have enjoyed
building the budget solver. Rungs 1–3 fix things that are broken today. Rungs 4–5
are architecture for a problem we have not measured.

## Where the authority lives

In `@spatialdata/core`, with the **Resource Resolver** ([ADR 0004](0004-resource-resolver-owned-by-core.md)).
It needs **no new package and no dependency inversion**: it registers caches
downward through injection points that already exist.

- zarr decoded → `enableWorkerChunkDecode({ cache })` (exists, unused)
- zarr encoded → a caching `zarr.Readable` wrapper at `createPrefixedStore`'s layer
  (rung 4 only)
- parquet, both tiers → direct ownership in `VTableSource`
- points resident batches → the points resolver's own entries

fizarrita and the parquet sources become **clients** of the authority, never
authorities themselves.

## Notes for the implementer

- **An encoded-bytes cache cannot live at fizarrita's seam.** Raw bytes are fetched
  on the main thread and then *transferred* — neutered — into the worker; the main
  thread loses them. `ChunkCache.set` takes a decoded `Chunk`. The only place
  compressed chunk bytes are visible is `arr.store.get(chunkPath)`, i.e. the store
  layer, i.e. `createPrefixedStore`.
- **Beware store identity.** fizarrita builds cache keys as
  `store_${N}:${arr.path}:${chunkKey}`, where `N` comes from a `WeakMap` on the
  **store object instance**. `createPrefixedStore` returns a **fresh object literal
  on every call**, so two prefixed views over the same root get different `store_N`
  and would double-cache. Hold a stable prefixed-store instance per element.
- **In-flight dedup is fizarrita's job now, not ours.** It used to check the cache
  while building its task list and write back only after the worker returned, so
  two concurrent requests for one chunk both fetched and both decoded; the note
  here said to key pending promises ourselves. Since 2.1.0 it keys them itself,
  the same way it keys the chunk cache, so the zarr side needs nothing. The
  parquet side still keys its own — `parquetTableCache` is the in-repo precedent,
  and also the cautionary tale (see the rejection-poisoning bug above).
- **`Resolution.stale` needs a drop policy, and it bounds the `Resolution`
  contract.** A `failed` resolution holding `stale: PointsLoadResult` pins roughly
  48 MB indefinitely. Today's code leaks the same memory implicitly; the type makes
  it a *named, typed, easy-to-keep-forever* field.

  **Policy:** drop `stale` on eviction, and on a **non-retryable** failure (the
  value can never be superseded, so retaining it only helps the current frame).
  Retain it across a **retryable** failure and across an in-flight refine.

  This is a deliberate qualification of the `Resolution` contract, and `CONTEXT.md`
  states it the same way: **`stale` is a retention, not a guarantee.** "A failed
  refine does not blank the view" holds *while `stale` is retained*. Once released,
  the resource is not renderable and the UI shows the **Spatial Entry Error**
  instead. Consumers must handle the no-stale case; they may not assume a
  previously-ready resource stays drawable.
- **Fill-value chunks are cached too.** fizarrita caches a full zero-filled typed
  array per *absent* chunk — a memory trap for sparse arrays.

## Owed upstream to fizarrita

**All four are resolved as of fizarrita 2.1.0.** Kept as a record of what was
wrong and where it was fixed, because two of them shaped decisions elsewhere in
this ADR and the reasoning is easier to follow with the original complaint
attached.

1. ~~**`probeDecompressedSize` does not recognise `imagecodecs_jpeg2k` or HTJ2K.**~~
   Its compression sniff knew only `gzip|zlib|blosc|zstd|lz4|bz2|lzma|snappy`, so
   for JP2K-backed images it took the "not compressed" branch and returned the
   *compressed* byte length as the decompressed size, then fed that to
   `inferChunkShape`. **This affected our imagery.** Fixed in
   [worker-pool#9](https://github.com/fideus-labs/worker-pool/pull/9) by inverting
   the test: allowlist the codecs known to *preserve* byte count and treat an
   unrecognised codec as size-changing, since misjudging that way costs one decode
   through the existing fallback while the other way returns a silently wrong
   number.
2. ~~**Two extra store round-trips per tile.**~~ Every `getWorker` call re-read
   `zarr.json`/`.zarray` *and* ran `probeActualChunkShape`, before the cache was
   consulted, so even a populated chunk cache could not eliminate them. Fixed in
   [worker-pool#14](https://github.com/fideus-labs/worker-pool/pull/14), which
   memoises both per `(store, path)`.
3. ~~**No in-flight dedup on the chunk path.**~~ Fixed in
   [worker-pool#10](https://github.com/fideus-labs/worker-pool/pull/10): in-flight
   operations are keyed the same way the chunk cache is, so concurrent readers of
   one chunk share a single fetch and a single decode.
4. ~~**No `AbortSignal`.**~~ `GetWorkerOptions` now takes a `signal`, forwarded to
   every `store.get` — metadata, probe, and chunk fetches — with still-queued pool
   tasks dropped when it fires
   ([worker-pool#15](https://github.com/fideus-labs/worker-pool/pull/15)).
   Taken up here: `zarrextra` forwards the caller's signal to both backends and
   its `rejectOnAbort` wrapper is gone. That wrapper only stopped us *awaiting* a
   read — the fetch and the decode ran to completion regardless — so a pan that
   outran its tiles paid full price for every tile it had abandoned.

## Consequences

- Memory becomes **test-assertable** for the first time.
- The points "memory cap" can become a real byte ceiling instead of a magic row
  count, and a shapes cap becomes possible at all.
- Zarr tiles stop re-fetching on every pan.
- We take on a `MemoryReporting` obligation on new caches. Keep it cheap: maintain
  a running total on insert/evict rather than scanning residents per read.
