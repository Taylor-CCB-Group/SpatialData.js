import { describe, expect, it } from 'vitest';
import * as zarr from 'zarrita';
import { registerJpeg2kCodec, wrapZarrRegistryForFizarritaWorker } from '../src/codecs';

const encoder = new TextEncoder();

function createCodecArrayStore(codecName: string): Map<string, Uint8Array> {
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
          codecs: [{ name: codecName, configuration: {} }],
          attributes: {},
        })
      ),
    ],
    ['/c/0/0', new Uint8Array([99])],
  ]);
}

describe('codec registration', () => {
  it('registers JPEG2K-compatible decoders in Zarrita', async () => {
    const codecName = 'imagecodecs_jpeg2k';
    const previous = zarr.registry.get(codecName);
    zarr.registry.delete(codecName);

    try {
      const arrBefore = await zarr.open(createCodecArrayStore(codecName) as zarr.Readable, {
        kind: 'array',
      });
      await expect(zarr.get(arrBefore, [null, null])).rejects.toThrow(/Unknown codec/);

      registerJpeg2kCodec({
        ids: [codecName],
        decoder: () => new Uint8Array([1, 2, 3, 4]),
      });

      const arrAfter = await zarr.open(createCodecArrayStore(codecName) as zarr.Readable, {
        kind: 'array',
      });
      const chunk = await zarr.get(arrAfter, [null, null]);

      expect(typeof chunk).toBe('object');
      expect((chunk as zarr.Chunk<'uint8'>).shape).toEqual([2, 2]);
      expect(Array.from((chunk as zarr.Chunk<'uint8'>).data)).toEqual([1, 2, 3, 4]);
    } finally {
      if (previous) {
        zarr.registry.set(codecName, previous);
      } else {
        zarr.registry.delete(codecName);
      }
    }
  });

  it('accepts fizarrita worker chunk metadata shape (data_type, chunk_shape)', async () => {
    const codecName = 'imagecodecs_jpeg2k';
    const previous = zarr.registry.get(codecName);
    zarr.registry.delete(codecName);

    try {
      registerJpeg2kCodec({
        ids: [codecName],
        decoder: () => new Uint8Array([5, 6, 7, 8]),
      });

      const factory = zarr.registry.get(codecName);
      expect(factory).toBeDefined();
      if (!factory) throw new Error('Expected codec factory to be registered.');

      const entry = await factory();
      const codec = entry.fromConfig({}, {
        data_type: 'uint8',
        chunk_shape: [2, 2],
        codecs: [{ name: codecName, configuration: {} }],
      });

      const chunk = await codec.decode(new Uint8Array([99]));
      expect(Array.from((chunk as zarr.Chunk<'uint8'>).data)).toEqual([5, 6, 7, 8]);
      expect((chunk as zarr.Chunk<'uint8'>).shape).toEqual([2, 2]);
    } finally {
      if (previous) {
        zarr.registry.set(codecName, previous);
      } else {
        zarr.registry.delete(codecName);
      }
    }
  });

  it('wrapZarrRegistryForFizarritaWorker adapts built-in codecs to fizarrita metadata', async () => {
    wrapZarrRegistryForFizarritaWorker();
    const factory = zarr.registry.get('bytes');
    expect(factory).toBeDefined();
    if (!factory) throw new Error('Expected bytes codec factory to be registered.');

    const entry = await factory();
    const codec = entry.fromConfig(
      { endian: 'little' },
      {
        data_type: 'uint8',
        chunk_shape: [2, 2],
        codecs: [{ name: 'bytes', configuration: { endian: 'little' } }],
      }
    );

    const chunk = await codec.decode(new Uint8Array([1, 2, 3, 4]));
    expect(Array.from((chunk as zarr.Chunk<'uint8'>).data)).toEqual([1, 2, 3, 4]);
    expect((chunk as zarr.Chunk<'uint8'>).shape).toEqual([2, 2]);
  });
});
