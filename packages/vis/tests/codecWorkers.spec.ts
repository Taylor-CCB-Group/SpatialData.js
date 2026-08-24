import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Chunk, DataType } from 'zarrita';
import * as zarr from 'zarrita';

const enableWorkerChunkDecode = vi.hoisted(() => vi.fn());

vi.mock('zarrextra/workers', () => ({
  enableWorkerChunkDecode,
}));

function installWorker() {
  Object.defineProperty(globalThis, 'Worker', {
    value: class TestWorker {},
    configurable: true,
  });
}

/** A decoded chunk of `bytes` bytes, shaped like whatever fizarrita hands back. */
function chunkOf(bytes: number): Chunk<DataType> {
  return {
    data: new Uint8Array(bytes),
    shape: [bytes],
    stride: [1],
  };
}

/** The cache handed to fizarrita on the most recent call. */
function passedCache() {
  return enableWorkerChunkDecode.mock.calls.at(-1)?.[0]?.cache;
}

describe('ensureCodecWorkers', () => {
  beforeEach(() => {
    vi.resetModules();
    enableWorkerChunkDecode.mockClear();
    Reflect.deleteProperty(globalThis, 'Worker');
  });

  it('does nothing outside browser worker environments', async () => {
    const { ensureCodecWorkers, getChunkCache } = await import('../src/codecWorkers');

    expect(ensureCodecWorkers()).toBe(false);
    expect(enableWorkerChunkDecode).not.toHaveBeenCalled();
    expect(getChunkCache()).toBeUndefined();
  });

  it('enables the bundled codec worker once', async () => {
    installWorker();
    const { ensureCodecWorkers } = await import('../src/codecWorkers');

    expect(ensureCodecWorkers()).toBe(true);
    expect(ensureCodecWorkers()).toBe(true);
    expect(enableWorkerChunkDecode).toHaveBeenCalledOnce();
  });

  it('fills fizarrita chunk-cache seam, which was previously left empty', async () => {
    installWorker();
    const { ensureCodecWorkers, getChunkCache, DEFAULT_CHUNK_CACHE_MAX_BYTES } = await import(
      '../src/codecWorkers'
    );
    ensureCodecWorkers();

    const cache = passedCache();
    expect(cache).toBeDefined();
    expect(cache).toBe(getChunkCache());
    expect(cache.maxBytes).toBe(DEFAULT_CHUNK_CACHE_MAX_BYTES);
    // fizarrita's `ChunkCache` contract is exactly these two.
    expect(typeof cache.get).toBe('function');
    expect(typeof cache.set).toBe('function');
  });

  it('accounts for the decoded bytes it holds, and bounds them', async () => {
    installWorker();
    const { ensureCodecWorkers, getChunkCache } = await import('../src/codecWorkers');
    ensureCodecWorkers({ chunkCacheMaxBytes: 100 });

    const cache = getChunkCache();
    expect(cache?.byteLength).toBe(0);

    cache?.set('store_0:/0:c/0/0', chunkOf(60));
    expect(cache?.byteLength).toBe(60);

    cache?.set('store_0:/0:c/0/1', chunkOf(60));
    expect(cache?.byteLength).toBe(60);
    expect(cache?.has('store_0:/0:c/0/0')).toBe(false);
    expect(cache?.get('store_0:/0:c/0/1')).toBeDefined();
  });

  it('reads the ceiling only on the call that builds the cache', async () => {
    installWorker();
    const { ensureCodecWorkers, getChunkCache } = await import('../src/codecWorkers');

    ensureCodecWorkers({ chunkCacheMaxBytes: 100 });
    ensureCodecWorkers({ chunkCacheMaxBytes: 999 });

    expect(getChunkCache()?.maxBytes).toBe(100);
  });
});

describe('chunk cache accounting', () => {
  beforeEach(() => {
    vi.resetModules();
    enableWorkerChunkDecode.mockClear();
    Reflect.deleteProperty(globalThis, 'Worker');
  });

  it('refuses a ceiling that would silently disable the bound', async () => {
    installWorker();
    const { ensureCodecWorkers, getChunkCache } = await import('../src/codecWorkers');

    // `Infinity` and `NaN` are valid numbers that make every
    // `resident > maxBytes` comparison false, so a host could turn the bound off
    // by accident. `ByteLruCache` rejects them at construction, which is what
    // makes the ceiling here safe to take from a caller unchecked.
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, -1]) {
      expect(() => ensureCodecWorkers({ chunkCacheMaxBytes: bad })).toThrow(RangeError);
    }

    // ...and a rejected ceiling leaves nothing half-enabled.
    expect(getChunkCache()).toBeUndefined();
    expect(enableWorkerChunkDecode).not.toHaveBeenCalled();
  });

  it('measures string chunks by their bytes, not their element count', async () => {
    installWorker();
    const { ensureCodecWorkers, getChunkCache } = await import('../src/codecWorkers');
    ensureCodecWorkers();

    // zarrita hands back its own string-array types for string dtypes, and they
    // report a real `byteLength` over their backing buffer — so they take the
    // typed-array branch. Element count would be 3 here; the bytes are far more.
    const strings = new zarr.UnicodeStringArray(8, ['alpha', 'beta', 'gamma']);
    const cache = getChunkCache();
    cache?.set('store_0:/labels:c/0', {
      data: strings,
      shape: [3],
      stride: [1],
    } as unknown as Chunk<DataType>);

    expect(strings.byteLength).toBeGreaterThan(strings.length);
    expect(cache?.byteLength).toBe(strings.byteLength);
  });
});
