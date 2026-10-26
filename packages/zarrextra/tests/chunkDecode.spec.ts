import * as zarr from 'zarrita';
import { describe, expect, it, vi } from 'vitest';
import {
  getChunkDecodeBackend,
  getZarrChunk,
  setChunkDecodeBackend,
  setFizarritaGetWorker,
} from '../src/chunkDecode';

const encoder = new TextEncoder();

function createArrayStore(): Map<string, Uint8Array> {
  return new Map<string, Uint8Array>([
    [
      '/zarr.json',
      encoder.encode(
        JSON.stringify({
          zarr_format: 3,
          node_type: 'array',
          shape: [2, 2],
          data_type: 'uint8',
          chunk_grid: {
            name: 'regular',
            configuration: { chunk_shape: [2, 2] },
          },
          chunk_key_encoding: {
            name: 'default',
            configuration: { separator: '/' },
          },
          fill_value: 0,
          codecs: [{ name: 'bytes', configuration: { endian: 'little' } }],
          attributes: {},
        })
      ),
    ],
    ['/c/0/0', new Uint8Array([1, 2, 3, 4])],
  ]);
}

describe('getZarrChunk', () => {
  it('uses main-thread zarr.get by default', async () => {
    setChunkDecodeBackend({ kind: 'main' });
    const arr = await zarr.open(createArrayStore() as zarr.Readable, { kind: 'array' });
    const chunk = await getZarrChunk(arr, [null, null]);
    expect(Array.from((chunk as zarr.Chunk<'uint8'>).data)).toEqual([1, 2, 3, 4]);
  });

  it('rejects a point selection rather than returning a bare scalar', async () => {
    // The one case where the static type lies. `selection` is declared as
    // `Array<number | Slice | null>`, so zarrita's conditional return type
    // resolves on its `null` branch and promises `Chunk<D>` — but the branch
    // taken at runtime depends on the values, and an all-number selection
    // indexes a single point, which zarrita unwraps to a scalar. Without the
    // guard that scalar would be handed back typed as a chunk and crash on the
    // first `.data` downstream.
    setChunkDecodeBackend({ kind: 'main' });
    const arr = await zarr.open(createArrayStore() as zarr.Readable, { kind: 'array' });

    await expect(getZarrChunk(arr, [0, 0])).rejects.toThrow(
      'Expected chunk object from zarr.get().'
    );
  });

  it('delegates to fizarrita getWorker when that backend is enabled', async () => {
    const getWorker = vi.fn(async () => ({
      data: new Uint8Array([9, 8, 7, 6]),
      shape: [2, 2],
      stride: [2, 1],
    }));
    setFizarritaGetWorker(getWorker);

    const pool = { terminateWorkers: vi.fn() };
    setChunkDecodeBackend({
      kind: 'fizarrita',
      pool: pool as never,
      options: { workerUrl: new URL('https://example.test/codec-worker.js') },
    });

    const arr = await zarr.open(createArrayStore() as zarr.Readable, { kind: 'array' });
    const chunk = await getZarrChunk(arr, [null, null]);

    expect(getWorker).toHaveBeenCalledOnce();
    expect(Array.from((chunk as zarr.Chunk<'uint8'>).data)).toEqual([9, 8, 7, 6]);

    setChunkDecodeBackend({ kind: 'main' });
  });

  it('reports the active backend', () => {
    setChunkDecodeBackend({ kind: 'main' });
    expect(getChunkDecodeBackend()).toEqual({ kind: 'main' });
  });
});

describe('getZarrChunk cancellation', () => {
  it('hands the caller signal to fizarrita rather than watching it here', async () => {
    const controller = new AbortController();
    const getWorker = vi.fn(async () => ({
      data: new Uint8Array([1, 2, 3, 4]),
      shape: [2, 2],
      stride: [2, 1],
    }));
    setFizarritaGetWorker(getWorker as never);
    setChunkDecodeBackend({ kind: 'fizarrita', pool: {} as never });

    const store = createArrayStore();
    const arr = await zarr.open(store as never, { kind: 'array' });
    await getZarrChunk(arr, [null, null], { signal: controller.signal });

    expect(getWorker).toHaveBeenCalledOnce();
    expect(getWorker.mock.calls[0]?.[2]).toMatchObject({ signal: controller.signal });

    setChunkDecodeBackend({ kind: 'main' });
  });

  it('omits the signal when the caller gives none', async () => {
    const getWorker = vi.fn(async () => ({
      data: new Uint8Array([1, 2, 3, 4]),
      shape: [2, 2],
      stride: [2, 1],
    }));
    setFizarritaGetWorker(getWorker as never);
    setChunkDecodeBackend({ kind: 'fizarrita', pool: {} as never });

    const store = createArrayStore();
    const arr = await zarr.open(store as never, { kind: 'array' });
    await getZarrChunk(arr, [null, null]);

    expect(getWorker.mock.calls[0]?.[2]?.signal).toBeUndefined();

    setChunkDecodeBackend({ kind: 'main' });
  });

  it('passes the signal down to the store on the main-thread path', async () => {
    // The distinction this change is about: a cancelled read has to reach the
    // work, not just stop us looking at it. What is ours to guarantee is that
    // the signal arrives at `store.get` — whether the request then unwinds is
    // the store's business (a `FetchStore` aborts; this fake ignores it, which
    // is why the read below still resolves).
    const backing = createArrayStore();
    const controller = new AbortController();
    let chunkReadSignal: AbortSignal | undefined;

    const store = {
      get: async (key: string, opts?: { signal?: AbortSignal }) => {
        if (key === '/c/0/0') {
          chunkReadSignal = opts?.signal;
        }
        return backing.get(key);
      },
    };

    const arr = await zarr.open(store as never, { kind: 'array' });
    await getZarrChunk(arr, [null, null], { signal: controller.signal });

    expect(chunkReadSignal).toBe(controller.signal);
  });

  it('rejects an already-aborted read without touching the store', async () => {
    const controller = new AbortController();
    controller.abort(new Error('cancelled before it started'));

    const get = vi.fn(async (key: string) => createArrayStore().get(key));
    const metadataOnly = { get: async (key: string) => createArrayStore().get(key) };
    const arr = await zarr.open(metadataOnly as never, { kind: 'array' });
    // Swap in the counting store only after `open` has read the metadata, so
    // the count reflects chunk reads alone.
    (arr as unknown as { store: unknown }).store = { get };

    await expect(getZarrChunk(arr, [null, null], { signal: controller.signal })).rejects.toThrow(
      'cancelled before it started'
    );
    expect(get).not.toHaveBeenCalled();
  });
});

describe('getZarrChunk with a per-read cache', () => {
  /** A 1-D uint8 array of four values in two chunks, recording each chunk read. */
  function createChunkedStore() {
    const backing = new Map<string, Uint8Array>([
      [
        '/zarr.json',
        encoder.encode(
          JSON.stringify({
            zarr_format: 3,
            node_type: 'array',
            shape: [4],
            data_type: 'uint8',
            chunk_grid: { name: 'regular', configuration: { chunk_shape: [2] } },
            chunk_key_encoding: { name: 'default', configuration: { separator: '/' } },
            fill_value: 0,
            codecs: [{ name: 'bytes', configuration: { endian: 'little' } }],
            attributes: {},
          })
        ),
      ],
      ['/c/0', new Uint8Array([1, 2])],
      ['/c/1', new Uint8Array([3, 4])],
    ]);
    const chunkReads: { key: string; signal?: AbortSignal }[] = [];
    let hold: Promise<void> | undefined;
    const store = {
      chunkReads,
      /** Hold chunk reads until the returned function is called. */
      holdReads() {
        let release = () => {};
        hold = new Promise((resolve) => {
          release = resolve;
        });
        return release;
      },
      async get(key: zarr.AbsolutePath, opts?: { signal?: AbortSignal }) {
        if (key.includes('/c/')) {
          chunkReads.push({ key, signal: opts?.signal });
          await hold;
          opts?.signal?.throwIfAborted();
        }
        return backing.get(key);
      },
    };
    return store;
  }

  function newCache() {
    const entries = new Map<string, zarr.Chunk<zarr.DataType>>();
    return {
      entries,
      get: (key: string) => entries.get(key),
      set: (key: string, chunk: zarr.Chunk<zarr.DataType>) => {
        entries.set(key, chunk);
      },
    };
  }

  it('reads each chunk once for reads through one cache, and again for another', async () => {
    setChunkDecodeBackend({ kind: 'main' });
    const store = createChunkedStore();
    const arr = await zarr.open(store, { kind: 'array' });
    const cache = newCache();

    const [left, right] = await Promise.all([
      getZarrChunk(arr, [zarr.slice(0, 3)], { cache }),
      getZarrChunk(arr, [zarr.slice(1, 4)], { cache }),
    ]);
    const again = await getZarrChunk(arr, [null], { cache });
    expect(Array.from(left.data)).toEqual([1, 2, 3]);
    expect(Array.from(right.data)).toEqual([2, 3, 4]);
    expect(Array.from(again.data)).toEqual([1, 2, 3, 4]);
    expect(store.chunkReads.map((r) => r.key).sort()).toEqual(['/c/0', '/c/1']);

    await getZarrChunk(arr, [null], { cache: newCache() });
    expect(store.chunkReads).toHaveLength(4);
  });

  it('keeps a shared read going while any caller wants it, and cancels it when none do', async () => {
    setChunkDecodeBackend({ kind: 'main' });
    const store = createChunkedStore();
    const arr = await zarr.open(store, { kind: 'array' });
    const cache = newCache();
    const release = store.holdReads();

    const staying = new AbortController();
    const leaving = new AbortController();
    const kept = getZarrChunk(arr, [zarr.slice(0, 2)], { cache, signal: staying.signal });
    const left = getZarrChunk(arr, [zarr.slice(0, 2)], { cache, signal: leaving.signal });
    await vi.waitFor(() => expect(store.chunkReads).toHaveLength(1));
    leaving.abort();
    await expect(left).rejects.toMatchObject({ name: 'AbortError' });
    expect(store.chunkReads[0]?.signal?.aborted).toBe(false);

    const gone = [new AbortController(), new AbortController()];
    const both = gone.map((c) =>
      getZarrChunk(arr, [zarr.slice(2, 4)], { cache, signal: c.signal })
    );
    await vi.waitFor(() => expect(store.chunkReads).toHaveLength(2));
    for (const c of gone) c.abort();
    for (const read of both) await expect(read).rejects.toMatchObject({ name: 'AbortError' });
    expect(store.chunkReads[1]?.signal?.aborted).toBe(true);

    // A cancelled read is not one a later caller can join.
    const again = getZarrChunk(arr, [zarr.slice(2, 4)], { cache });
    release();
    expect(Array.from((await kept).data)).toEqual([1, 2]);
    expect(Array.from((await again).data)).toEqual([3, 4]);
    expect(store.chunkReads.map((r) => r.key)).toEqual(['/c/0', '/c/1', '/c/1']);
  });

  it("hands fizarrita the read's cache in place of the backend's", async () => {
    const getWorker = vi.fn(async () => ({
      data: new Uint8Array([1, 2, 3, 4]),
      shape: [2, 2],
      stride: [2, 1],
    }));
    setFizarritaGetWorker(getWorker as never);
    const backendCache = newCache();
    setChunkDecodeBackend({
      kind: 'fizarrita',
      pool: {} as never,
      options: { cache: backendCache },
    });
    const arr = await zarr.open(createArrayStore() as never, { kind: 'array' });
    const cache = newCache();

    await getZarrChunk(arr, [null, null], { cache });
    await getZarrChunk(arr, [null, null]);
    expect(getWorker.mock.calls[0]?.[2]).toMatchObject({ cache });
    expect(getWorker.mock.calls[1]?.[2]).toMatchObject({ cache: backendCache });

    setChunkDecodeBackend({ kind: 'main' });
  });
});
