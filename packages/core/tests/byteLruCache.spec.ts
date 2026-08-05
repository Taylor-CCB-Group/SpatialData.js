import { describe, expect, it, vi } from 'vitest';
import { ByteLruCache } from '../src/memory/byteLruCache.js';
import type { MemoryReporting } from '../src/memory/memoryReporting.js';

/** The ergonomic claim ADR 0005 makes for `MemoryReporting`, as a compile-time check. */
const _typedArrayReportsMemory: MemoryReporting = new Uint8Array(8);

function bytesCache(maxBytes: number, onDispose?: (value: Uint8Array, key: string) => void) {
  return new ByteLruCache<Uint8Array>({
    maxBytes,
    sizeOf: (value) => value.byteLength,
    onDispose,
  });
}

describe('ByteLruCache', () => {
  it('reports resident bytes as a running total', () => {
    const cache = bytesCache(1000);
    expect(cache.byteLength).toBe(0);

    cache.set('a', new Uint8Array(100));
    cache.set('b', new Uint8Array(250));

    expect(cache.byteLength).toBe(350);
    expect(cache.size).toBe(2);
  });

  it('evicts least-recently-used entries until it fits', () => {
    const cache = bytesCache(300);
    cache.set('a', new Uint8Array(100));
    cache.set('b', new Uint8Array(100));
    cache.set('c', new Uint8Array(100));
    expect(cache.byteLength).toBe(300);

    cache.set('d', new Uint8Array(100));

    expect(cache.has('a')).toBe(false);
    expect([...cache.keys()]).toEqual(['b', 'c', 'd']);
    expect(cache.byteLength).toBe(300);
  });

  it('counts a read as a use, so the read entry survives the next eviction', () => {
    const cache = bytesCache(300);
    cache.set('a', new Uint8Array(100));
    cache.set('b', new Uint8Array(100));
    cache.set('c', new Uint8Array(100));

    expect(cache.get('a')).toBeDefined();
    cache.set('d', new Uint8Array(100));

    expect(cache.has('a')).toBe(true);
    expect(cache.has('b')).toBe(false);
  });

  it('does not count a peek as a use', () => {
    const cache = bytesCache(300);
    cache.set('a', new Uint8Array(100));
    cache.set('b', new Uint8Array(100));
    cache.set('c', new Uint8Array(100));

    expect(cache.peek('a')).toBeDefined();
    cache.set('d', new Uint8Array(100));

    expect(cache.has('a')).toBe(false);
  });

  it('replaces rather than double-counts when a key is overwritten', () => {
    const onDispose = vi.fn();
    const cache = bytesCache(1000, onDispose);
    const first = new Uint8Array(100);
    cache.set('a', first);
    cache.set('a', new Uint8Array(400));

    expect(cache.size).toBe(1);
    expect(cache.byteLength).toBe(400);
    expect(onDispose).toHaveBeenCalledWith(first, 'a');
  });

  it('disposes evicted, deleted and cleared entries exactly once', () => {
    const onDispose = vi.fn();
    const cache = bytesCache(200, onDispose);
    const evicted = new Uint8Array(100);
    cache.set('evicted', evicted);
    cache.set('deleted', new Uint8Array(100));
    cache.set('cleared', new Uint8Array(100));
    expect(onDispose).toHaveBeenCalledExactlyOnceWith(evicted, 'evicted');

    cache.delete('deleted');
    expect(cache.byteLength).toBe(100);

    cache.clear();
    expect(cache.byteLength).toBe(0);
    expect(cache.size).toBe(0);
    expect(onDispose).toHaveBeenCalledTimes(3);
  });

  it('picks up a size that only became known after insertion', () => {
    // The parquet table cache's shape: the entry is inserted while the decode is
    // still in flight, so its byte count is zero until the table exists.
    const cache = new ByteLruCache<{ byteLength: number }>({
      maxBytes: 300,
      sizeOf: (value) => value.byteLength,
    });
    const pending = { byteLength: 0 };
    cache.set('pending', pending);
    cache.set('other', { byteLength: 100 });
    expect(cache.byteLength).toBe(100);

    pending.byteLength = 250;
    cache.recount('pending');

    expect(cache.byteLength).toBe(250);
    // 350 would have been over budget, so the older entry went.
    expect(cache.has('other')).toBe(false);
    expect(cache.has('pending')).toBe(true);
  });

  it('ignores a recount for a key it no longer holds', () => {
    const cache = bytesCache(1000);
    cache.set('a', new Uint8Array(100));
    cache.delete('a');

    expect(() => cache.recount('a')).not.toThrow();
    expect(cache.byteLength).toBe(0);
  });

  it('admits a value larger than the whole budget rather than reporting a miss', () => {
    // Refusing it would be worse than exceeding the bound: `loadParquetBytes` is
    // called ~20 times per points load, and a permanent miss means ~20 refetches
    // of a file too big to fetch even once cheaply.
    const cache = bytesCache(300);
    cache.set('small', new Uint8Array(100));
    const huge = new Uint8Array(5000);
    cache.set('huge', huge);

    expect(cache.get('huge')).toBe(huge);
    expect(cache.size).toBe(1);
    expect(cache.byteLength).toBe(5000);

    // ...and it is the first thing to go once anything else arrives.
    cache.set('next', new Uint8Array(100));
    expect(cache.has('huge')).toBe(false);
    expect(cache.byteLength).toBe(100);
  });

  it('refuses a ceiling that would disable eviction', () => {
    // NaN is the one that matters: every `resident > max` comparison against it
    // is false, so the cache would report nonsense and never evict again.
    expect(() => bytesCache(Number.NaN)).toThrow(RangeError);
    expect(() => bytesCache(Number.POSITIVE_INFINITY)).toThrow(RangeError);
    expect(() => bytesCache(-1)).toThrow(RangeError);
  });

  it('refuses a size that would corrupt the running total', () => {
    const cache = new ByteLruCache<string>({ maxBytes: 100, sizeOf: () => Number.NaN });

    expect(() => cache.set('a', 'x')).toThrow(RangeError);
    expect(cache.byteLength).toBe(0);
  });

  it('finishes evicting even when disposal throws', () => {
    const disposed: string[] = [];
    const cache = bytesCache(200, (_value, key) => {
      disposed.push(key);
      throw new Error(`dispose failed for ${key}`);
    });
    cache.set('a', new Uint8Array(100));
    cache.set('b', new Uint8Array(100));

    // Admitting 500 bytes has to evict both 100-byte entries to get under 200.
    expect(() => cache.set('c', new Uint8Array(500))).toThrow('dispose failed for a');

    expect(disposed).toEqual(['a', 'b']);
    expect(cache.size).toBe(1);
    expect(cache.byteLength).toBe(500);
  });

  it('finishes clearing even when disposal throws', () => {
    const disposed: string[] = [];
    const cache = bytesCache(1000, (_value, key) => {
      disposed.push(key);
      throw new Error(`dispose failed for ${key}`);
    });
    cache.set('a', new Uint8Array(10));
    cache.set('b', new Uint8Array(10));

    expect(() => cache.clear()).toThrow('dispose failed for a');

    expect(disposed).toEqual(['a', 'b']);
    expect(cache.size).toBe(0);
    expect(cache.byteLength).toBe(0);
  });

  it('satisfies MemoryReporting', () => {
    const cache: MemoryReporting = bytesCache(100);
    expect(cache.byteLength).toBe(0);
    expect(_typedArrayReportsMemory.byteLength).toBe(8);
  });
});
