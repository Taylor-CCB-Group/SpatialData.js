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
