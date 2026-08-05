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
 * Reject a byte count that would corrupt the accounting rather than merely be wrong.
 *
 * `NaN` is the dangerous one: every `residentBytes > maxBytes` comparison against
 * it is false, so a single `NaN` — from a ceiling passed through an unparsed
 * config value, or from a `sizeOf` that met an unexpected payload — silently
 * disables eviction for the lifetime of the cache. A bounded cache quietly
 * becomes an unbounded one, which is the exact failure it exists to prevent.
 * Infinity and negatives are the same class of mistake and equally cheap to
 * refuse here, at the one place a bad number can enter.
 */
function assertByteCount(value: number, label: string): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`${label} must be a finite, non-negative byte count; received ${value}`);
  }
  return value;
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
    this.maxBytes = assertByteCount(options.maxBytes, 'maxBytes');
    this.sizeOf = options.sizeOf;
    this.onDispose = options.onDispose;
  }

  /** `sizeOf`, with the result checked before it can reach the running total. */
  private measure(value: V): number {
    return assertByteCount(this.sizeOf(value), 'sizeOf(value)');
  }

  /**
   * Run `onDispose`, returning what it threw instead of throwing.
   *
   * Disposal is a courtesy at the end of a removal that has already happened;
   * letting it propagate mid-loop would abandon an eviction pass partway and
   * leave the cache over budget, or skip the rest of a `clear`. Callers finish
   * the structural work, then rethrow.
   */
  private disposeQuietly(value: V, key: string): unknown {
    if (!this.onDispose) {
      return undefined;
    }
    try {
      this.onDispose(value, key);
    } catch (error) {
      return error;
    }
    return undefined;
  }

  /** Drop an entry and its bytes, returning any error `onDispose` threw. */
  private removeEntry(key: string, entry: Entry<V>): unknown {
    this.entries.delete(key);
    this.residentBytes -= entry.bytes;
    return this.disposeQuietly(entry.value, key);
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
    const bytes = this.measure(value);
    this.entries.set(key, { value, bytes });
    this.residentBytes += bytes;
    const disposeError = previous ? this.disposeQuietly(previous.value, key) : undefined;
    this.evictToBudget();
    if (disposeError !== undefined) {
      throw disposeError;
    }
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
    const bytes = this.measure(entry.value);
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
    const disposeError = this.removeEntry(key, entry);
    if (disposeError !== undefined) {
      throw disposeError;
    }
    return true;
  }

  /**
   * Drop everything, disposing each entry.
   *
   * Every entry is disposed even if one of them throws; the first error is
   * rethrown once the cache is empty, so a single bad payload cannot strand the
   * rest.
   */
  clear(): void {
    const disposing = [...this.entries];
    this.entries.clear();
    this.residentBytes = 0;
    let firstError: unknown;
    for (const [key, entry] of disposing) {
      const error = this.disposeQuietly(entry.value, key);
      if (firstError === undefined) {
        firstError = error;
      }
    }
    if (firstError !== undefined) {
      throw firstError;
    }
  }

  /**
   * Evict from the least-recently-used end until within budget, stopping while
   * one entry remains so that an oversized value is kept rather than refused.
   *
   * A throwing `onDispose` does not stop the pass — abandoning it halfway would
   * leave the cache over its ceiling, which is worse than the failed disposal.
   * The first error surfaces once the cache is back within budget.
   */
  private evictToBudget(): void {
    let firstError: unknown;
    while (this.residentBytes > this.maxBytes && this.entries.size > 1) {
      const oldest = this.entries.keys().next();
      if (oldest.done) {
        break;
      }
      const entry = this.entries.get(oldest.value);
      if (!entry) {
        break;
      }
      const error = this.removeEntry(oldest.value, entry);
      if (firstError === undefined) {
        firstError = error;
      }
    }
    if (firstError !== undefined) {
      throw firstError;
    }
  }
}
