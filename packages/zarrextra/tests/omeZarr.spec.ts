import { describe, expect, it } from 'vitest';
import * as zarr from 'zarrita';
import { loadOmeZarrMultiscalesFromStore, registerJpeg2kCodec } from '../src';

const encoder = new TextEncoder();

function jsonBytes(value: unknown): Uint8Array {
  return encoder.encode(JSON.stringify(value));
}

type OmeAxisSpec = { name: string; type?: string; unit?: string };

function createRawArrayMetadata(shape: number[], chunkShape: number[]) {
  return {
    zarr_format: 3,
    node_type: 'array',
    shape,
    data_type: 'uint8',
    chunk_grid: {
      name: 'regular',
      configuration: { chunk_shape: chunkShape },
    },
    chunk_key_encoding: {
      name: 'default',
      configuration: { separator: '/' },
    },
    fill_value: 0,
    codecs: [{ name: 'bytes', configuration: { endian: 'little' } }],
    attributes: {},
  };
}

function createOmeZarrGroupStore(
  axes: OmeAxisSpec[],
  arrayMetadata: Record<string, unknown>,
  chunks: Map<string, Uint8Array>
): Map<string, Uint8Array> {
  const store = new Map<string, Uint8Array>([
    [
      '/zarr.json',
      jsonBytes({
        zarr_format: 3,
        node_type: 'group',
        attributes: {
          ome: {
            multiscales: [
              {
                axes,
                datasets: [{ path: '0' }],
              },
            ],
          },
        },
        consolidated_metadata: {
          kind: 'inline',
          must_understand: false,
          metadata: {
            '0': arrayMetadata,
          },
        },
      }),
    ],
  ]);
  for (const [path, bytes] of chunks) {
    store.set(path, bytes);
  }
  return store;
}

function createOmeZarrStore(): Map<string, Uint8Array> {
  return createOmeZarrGroupStore(
    [
      { name: 't', type: 'time' },
      { name: 'c', type: 'channel' },
      { name: 'z', type: 'space' },
      { name: 'y', type: 'space' },
      { name: 'x', type: 'space' },
    ],
    {
      ...createRawArrayMetadata([1, 1, 1, 2, 2], [1, 1, 1, 2, 2]),
      codecs: [{ name: 'imagecodecs_jpeg2k', configuration: {} }],
    },
    new Map([['/0/c/0/0/0/0/0', new Uint8Array([99])]])
  );
}

function indexedVolumeValue(t: number, c: number, z: number, y: number, x: number): number {
  return t * 100 + c * 10 + z + y * 4 + x;
}

function createMultiTzOmeZarrStore(): Map<string, Uint8Array> {
  const shape = [2, 1, 3, 4, 4];
  const chunkShape = [1, 1, 1, 4, 4];
  const chunks = new Map<string, Uint8Array>();

  for (let t = 0; t < shape[0]; t += 1) {
    for (let z = 0; z < shape[2]; z += 1) {
      const plane = new Uint8Array(shape[3] * shape[4]);
      for (let y = 0; y < shape[3]; y += 1) {
        for (let x = 0; x < shape[4]; x += 1) {
          plane[y * shape[4] + x] = indexedVolumeValue(t, 0, z, y, x);
        }
      }
      chunks.set(`/0/c/${t}/0/${z}/0/0`, plane);
    }
  }

  return createOmeZarrGroupStore(
    [
      { name: 't', type: 'time' },
      { name: 'c', type: 'channel' },
      { name: 'z', type: 'space' },
      { name: 'y', type: 'space' },
      { name: 'x', type: 'space' },
    ],
    createRawArrayMetadata(shape, chunkShape),
    chunks
  );
}

function createZcyxOmeZarrStore(): Map<string, Uint8Array> {
  const shape = [3, 2, 8, 8];
  const chunkShape = [1, 1, 8, 8];
  const plane = new Uint8Array(8 * 8);
  for (let y = 0; y < 8; y += 1) {
    for (let x = 0; x < 8; x += 1) {
      plane[y * 8 + x] = y * 8 + x;
    }
  }

  const chunks = new Map<string, Uint8Array>();
  for (let z = 0; z < shape[0]; z += 1) {
    for (let c = 0; c < shape[1]; c += 1) {
      chunks.set(`/0/c/${z}/${c}/0/0`, plane);
    }
  }

  return createOmeZarrGroupStore(
    [
      { name: 'z', type: 'space' },
      { name: 'c', type: 'channel' },
      { name: 'y', type: 'space' },
      { name: 'x', type: 'space' },
    ],
    createRawArrayMetadata(shape, chunkShape),
    chunks
  );
}

describe('OME-Zarr store loader', () => {
  it('creates Viv-compatible PixelSources backed by workspace Zarrita', async () => {
    const previous = zarr.registry.get('imagecodecs_jpeg2k');
    registerJpeg2kCodec({
      ids: ['imagecodecs_jpeg2k'],
      decoder: () => new Uint8Array([1, 2, 3, 4]),
    });

    try {
      const [source] = await loadOmeZarrMultiscalesFromStore(createOmeZarrStore() as zarr.Readable);
      expect(source.labels).toEqual(['t', 'c', 'z', 'y', 'x']);
      expect(source.shape).toEqual([1, 1, 1, 2, 2]);
      expect(source.dtype).toBe('Uint8');

      const tile = await source.getTile({ x: 0, y: 0, selection: { t: 0, c: 0, z: 0 } });
      expect(tile.width).toBe(2);
      expect(tile.height).toBe(2);
      expect(Array.from(tile.data as Uint8Array)).toEqual([1, 2, 3, 4]);
    } finally {
      if (previous) {
        zarr.registry.set('imagecodecs_jpeg2k', previous);
      } else {
        zarr.registry.delete('imagecodecs_jpeg2k');
      }
    }
  });

  it('returns distinct tiles for different z and t selections', async () => {
    const [source] = await loadOmeZarrMultiscalesFromStore(
      createMultiTzOmeZarrStore() as zarr.Readable
    );
    expect(source.shape).toEqual([2, 1, 3, 4, 4]);

    const tileTz0 = await source.getTile({ x: 0, y: 0, selection: { t: 0, c: 0, z: 0 } });
    const tileTz1 = await source.getTile({ x: 0, y: 0, selection: { t: 1, c: 0, z: 2 } });

    expect(tileTz0.width).toBe(4);
    expect(tileTz0.height).toBe(4);
    expect((tileTz0.data as Uint8Array)[0]).toBe(indexedVolumeValue(0, 0, 0, 0, 0));
    expect((tileTz1.data as Uint8Array)[0]).toBe(indexedVolumeValue(1, 0, 2, 0, 0));
    expect((tileTz0.data as Uint8Array)[0]).not.toBe((tileTz1.data as Uint8Array)[0]);
  });

  it('defaults missing z/t selection axes to index 0', async () => {
    const [source] = await loadOmeZarrMultiscalesFromStore(
      createMultiTzOmeZarrStore() as zarr.Readable
    );

    const explicit = await source.getTile({ x: 0, y: 0, selection: { t: 0, c: 0, z: 0 } });
    const defaulted = await source.getTile({ x: 0, y: 0, selection: { c: 0 } });

    expect((defaulted.data as Uint8Array)[0]).toBe((explicit.data as Uint8Array)[0]);
  });

  it('resolves spatial axes from labels for non-canonical axis order', async () => {
    const [source] = await loadOmeZarrMultiscalesFromStore(createZcyxOmeZarrStore() as zarr.Readable);
    expect(source.labels).toEqual(['z', 'c', 'y', 'x']);
    expect(source.shape).toEqual([3, 2, 8, 8]);

    const tile = await source.getTile({ x: 0, y: 0, selection: { z: 1, c: 0 } });
    expect(tile.width).toBe(8);
    expect(tile.height).toBe(8);
    expect((tile.data as Uint8Array)[0]).toBe(0);
    expect((tile.data as Uint8Array)[7]).toBe(7);
  });
});
