import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Chunk, DataType } from 'zarrita';

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
  } as Chunk<DataType>;
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
