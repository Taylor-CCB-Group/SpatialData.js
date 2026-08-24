import { ByteLruCache } from '@spatialdata/core';
import { enableWorkerChunkDecode } from 'zarrextra/workers';
import type { Chunk, DataType } from 'zarrita';

/**
 * Default ceiling for the decoded zarr chunk cache, shared across every element.
 *
 * Sized to hold a working set rather than a history: a few screenfuls of tiles
 * across the scale levels a pan touches. Like the parquet ceilings this is a
 * guess that bounds a cache, not a measured working set — see ADR 0005.
 */
export const DEFAULT_CHUNK_CACHE_MAX_BYTES = 256 * 1024 * 1024;

export type EnsureCodecWorkersOptions = {
  /**
   * Override {@link DEFAULT_CHUNK_CACHE_MAX_BYTES}.
   *
   * Read on the first call that actually enables the workers, and ignored
   * afterwards — calls that no-op because `Worker` is unavailable read nothing,
   * so a later call in a worker-capable context still gets to set it. Must be a
   * finite, non-negative byte count; `ByteLruCache` rejects anything else.
   */
  chunkCacheMaxBytes?: number;
};

let enabled = false;
let chunkCache: ByteLruCache<Chunk<DataType>> | undefined;

/** Bytes a decoded chunk holds. */
function chunkByteLength(chunk: Chunk<DataType>): number {
  // Numeric dtypes give a typed array, which reports `byteLength` for free —
  // that structural match is the whole point of `MemoryReporting`. And numeric
  // is all this cache ever sees: the sole route in is zarrextra's
  // `ZarrPixelSource`, i.e. OME-Zarr pixel data, which is rejected long before
  // here if it is not a numeric raster.
  //
  // The `length` arm is therefore a floor for a payload that should not arrive
  // rather than a real measurement of one — element count, not UTF-8 bytes. It
  // exists because reporting zero would make such entries invisible to the
  // budget and so unevictable by size, which is the one way a bounded cache
  // quietly goes back to being unbounded. If string chunks ever do reach this
  // cache, this needs to become a real measurement.
  const data: { byteLength?: number; length: number } = chunk.data;
  return typeof data.byteLength === 'number' ? data.byteLength : data.length;
}

/**
 * The decoded chunk cache, once {@link ensureCodecWorkers} has built it.
 *
 * Exposed for inspection — `byteLength` is what it is holding right now — and for
 * `clear()`, which is how a host releases imagery it knows it is done with.
 * `undefined` before the workers are enabled.
 */
export function getChunkCache(): ByteLruCache<Chunk<DataType>> | undefined {
  return chunkCache;
}

/**
 * Enable the bundled zarrextra codec worker once for browser-based vis components.
 *
 * This is called automatically by SpatialCanvas renderer paths. It is exported for
 * hosts that want to opt in before mounting UI, without risking repeated worker
 * pool replacement.
 *
 * ### The chunk cache
 *
 * fizarrita has always accepted a `{ get, set }` cache here and we always passed
 * nothing, so it fell back to its no-op and *there was no chunk cache at all* —
 * every tile paid a network round-trip and a re-decode on every pan back across
 * ground already covered. Filling the seam is ADR 0005 rung 3, and a pure win:
 * there is nothing to trade off against a cache that did not exist.
 *
 * `ByteLruCache` satisfies fizarrita's `ChunkCache` structurally, so it is passed
 * as-is — its `get` is the lookup *and* the recency update, which is exactly what
 * that interface wants.
 *
 * Two things worth knowing about what ends up in here:
 *
 * - **Absent chunks are cached as data.** fizarrita materialises a full
 *   zero-filled typed array for a missing chunk and caches that like any other,
 *   so a sparse array can spend real bytes on nothing. The byte bound is what
 *   makes that survivable rather than a leak.
 * - **Concurrent readers of one chunk share a single fetch and decode.**
 *   fizarrita keys in-flight operations the same way it keys this cache, so the
 *   window between "someone started fetching this" and "the result is
 *   cacheable" no longer costs a duplicate round-trip and a duplicate decode.
 *   It follows that this cache sees one `set` per chunk however many readers
 *   wanted it, so the byte total counts each chunk once.
 *
 * Cache keys are `store_N:{array path}:{chunk key}`, where `N` identifies the
 * **store instance**. `RasterElement.getStore()` memoizes its prefixed view for
 * exactly that reason; a fresh view per caller would key the same chunk
 * differently per view and fill the cache with duplicates that never hit.
 */
export function ensureCodecWorkers(options?: EnsureCodecWorkersOptions): boolean {
  if (enabled || typeof Worker === 'undefined') {
    return enabled;
  }

  chunkCache = new ByteLruCache<Chunk<DataType>>({
    maxBytes: options?.chunkCacheMaxBytes ?? DEFAULT_CHUNK_CACHE_MAX_BYTES,
    sizeOf: chunkByteLength,
  });
  enableWorkerChunkDecode({ cache: chunkCache });
  enabled = true;
  return enabled;
}
