import type { MemoryReporting } from './memoryReporting.js';

export interface ByteLruCacheOptions<V> {
  /**
   * Resident-byte ceiling. Enforced after every insertion and every
   * {@link ByteLruCache.recount}, by dropping least-recently-used entries.
   *
   * Not an absolute guarantee — see {@link ByteLruCache} on oversized values.
   */
  maxBytes: number;
  /**
   * Bytes held by a value.
   *
   * Called once per insertion and once per {@link ByteLruCache.recount}, never
   * per read: the cache keeps a running total instead, which is the obligation
   * {@link MemoryReporting} takes on.
   */
  sizeOf: (value: V) => number;
  /**
   * Called as an entry leaves — evicted, overwritten, deleted or cleared —
   * exactly once per departure, after the cache's own bookkeeping is settled.
   *
   * For releasing something a garbage collector will not: a GPU buffer, a worker
   * handle. Plain typed arrays need nothing here.
   */
  onDispose?: (value: V, key: string) => void;
}

interface Entry<V> {
  value: V;
  bytes: number;
}

/**
 * A byte-bounded LRU cache that reports what it is holding.
 *
 * Framework-free and deliberately small — [ADR 0005](../../../../docs/adr/0005-memory-accounting-before-management.md)
 * rung 2 is *fixing a leak, not building an architecture*. It exists because the
 * two parquet caches in `VTableSource` were plain `Record`s that grew until the
 * source was discarded, and because filling fizarrita's chunk-cache seam needs
 * something bounded to fill it with.
 *
 * Recency is `Map` insertion order: re-inserting a key moves it to the tail, and
 * eviction takes from the head. {@link get} and {@link recount} count as uses;
 * {@link peek} and {@link has} do not.
 *
 * ### Oversized values are admitted, not refused
 *
 * If a single value exceeds `maxBytes`, it is stored anyway and left as the sole
 * resident — so the effective bound is *`maxBytes`, or one entry, whichever is
 * larger*. Refusing it would be the worse failure: `loadParquetBytes` is called
 * roughly twenty times per points load, so a value that can never be admitted
 * becomes twenty refetches of the very file that was too big to fetch once.
 *
 * ### Sizes that are not known at insertion
 *
 * A cache of in-flight promises cannot be sized when the entry goes in. Insert
 * it at whatever `sizeOf` can say (zero), and call {@link recount} once the real
 * size is knowable. That is why sizing is a callback the cache re-runs on demand
 * rather than a number captured at insertion.
 */
export class ByteLruCache<V> implements MemoryReporting {
  readonly maxBytes: number;
  private readonly sizeOf: (value: V) => number;
  private readonly onDispose?: (value: V, key: string) => void;
  private readonly entries = new Map<string, Entry<V>>();
  private residentBytes = 0;

  constructor(options: ByteLruCacheOptions<V>) {
    this.maxBytes = options.maxBytes;
    this.sizeOf = options.sizeOf;
    this.onDispose = options.onDispose;
  }

  /** Resident bytes, maintained incrementally — never a scan of the residents. */
  get byteLength(): number {
    return this.residentBytes;
  }

  /** Number of resident entries. */
  get size(): number {
    return this.entries.size;
  }

  /** Read a value, counting the read as a use. */
  get(key: string): V | undefined {
    const entry = this.entries.get(key);
    if (!entry) {
      return undefined;
    }
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.value;
  }

  /** Read a value *without* counting it as a use. */
  peek(key: string): V | undefined {
    return this.entries.get(key)?.value;
  }

  /** Whether a key is resident. Not a use. */
  has(key: string): boolean {
    return this.entries.has(key);
  }

  /** Resident keys, least-recently-used first. */
  keys(): IterableIterator<string> {
    return this.entries.keys();
  }

  /**
   * Insert or replace a value, then evict down to budget.
   *
   * Replacing a key disposes the value it displaced, so `set` is safe to use as
   * an upsert without leaking the previous payload.
   */
  set(key: string, value: V): void {
    const previous = this.entries.get(key);
    if (previous) {
      this.entries.delete(key);
      this.residentBytes -= previous.bytes;
    }
    const bytes = this.sizeOf(value);
    this.entries.set(key, { value, bytes });
    this.residentBytes += bytes;
    if (previous) {
      this.onDispose?.(previous.value, key);
    }
    this.evictToBudget();
  }

  /**
   * Re-ask `sizeOf` for a resident value whose size has changed since insertion,
   * then evict down to budget. A no-op for a key that is no longer resident.
   *
   * Counts as a use: the size becoming knowable — a decode landing, a payload
   * being filled in — is the moment the entry is most worth keeping, and the
   * eviction pass this triggers would otherwise be liable to drop it.
   */
  recount(key: string): void {
    const entry = this.entries.get(key);
    if (!entry) {
      return;
    }
    const bytes = this.sizeOf(entry.value);
    this.residentBytes += bytes - entry.bytes;
    entry.bytes = bytes;
    this.entries.delete(key);
    this.entries.set(key, entry);
    this.evictToBudget();
  }

  /** Drop a key. Returns whether it was resident. */
  delete(key: string): boolean {
    const entry = this.entries.get(key);
    if (!entry) {
      return false;
    }
    this.entries.delete(key);
    this.residentBytes -= entry.bytes;
    this.onDispose?.(entry.value, key);
    return true;
  }

  /** Drop everything, disposing each entry. */
  clear(): void {
    const disposing = [...this.entries];
    this.entries.clear();
    this.residentBytes = 0;
    if (this.onDispose) {
      for (const [key, entry] of disposing) {
        this.onDispose(entry.value, key);
      }
    }
  }

  /**
   * Evict from the least-recently-used end until within budget, stopping while
   * one entry remains so that an oversized value is kept rather than refused.
   */
  private evictToBudget(): void {
    while (this.residentBytes > this.maxBytes && this.entries.size > 1) {
      const oldest = this.entries.keys().next();
      if (oldest.done) {
        return;
      }
      this.delete(oldest.value);
    }
  }
}
