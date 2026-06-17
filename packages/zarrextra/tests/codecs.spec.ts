import { describe, expect, it } from 'vitest';
import * as zarr from 'zarrita';
import {
  registerExperimentalHtj2kCodec,
  registerJpeg2kCodec,
  wrapZarrRegistryForFizarritaWorker,
} from '../src/codecs';

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

  it('registers OpenJPH HTJ2K decoders in Zarrita', async () => {
    const codecName = 'experimental.openjph_htj2k';
    const previous = zarr.registry.get(codecName);
    zarr.registry.delete(codecName);

    try {
      const arrBefore = await zarr.open(createCodecArrayStore(codecName) as zarr.Readable, {
        kind: 'array',
      });
      await expect(zarr.get(arrBefore, [null, null])).rejects.toThrow(/Unknown codec/);

      registerExperimentalHtj2kCodec({
        ids: [codecName],
        decoder: () => new Uint8Array([9, 10, 11, 12]),
      });

      const arrAfter = await zarr.open(createCodecArrayStore(codecName) as zarr.Readable, {
        kind: 'array',
      });
      const chunk = await zarr.get(arrAfter, [null, null]);

      expect(typeof chunk).toBe('object');
      expect((chunk as zarr.Chunk<'uint8'>).shape).toEqual([2, 2]);
      expect(Array.from((chunk as zarr.Chunk<'uint8'>).data)).toEqual([9, 10, 11, 12]);
    } finally {
      if (previous) {
        zarr.registry.set(codecName, previous);
      } else {
        zarr.registry.delete(codecName);
      }
    }
  });

  it('still decodes legacy experimental.imagecodecs_htj2k ids', async () => {
    const codecName = 'experimental.imagecodecs_htj2k';
    const previous = zarr.registry.get(codecName);
    zarr.registry.delete(codecName);

    try {
      registerExperimentalHtj2kCodec({
        ids: [codecName],
        decoder: () => new Uint8Array([13, 14, 15, 16]),
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
      expect(Array.from((chunk as zarr.Chunk<'uint8'>).data)).toEqual([13, 14, 15, 16]);
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

  it('encodes and decodes a small HTJ2K plane with OpenJPH WASM', async () => {
    let openjph: Record<string, unknown>;
    try {
      openjph = await import('@cornerstonejs/codec-openjph');
    } catch {
      console.warn(
        'Skipping HTJ2K encode round-trip: @cornerstonejs/codec-openjph is not installed.'
      );
      return;
    }

    const { createOpenJphEncoder } = await import('../src/htj2k-encode');
    const { createOpenJphDecoder } = await import('../src/codecs');
    const factory = (openjph.default ?? openjph.OpenJPHJS ?? openjph) as Parameters<
      typeof createOpenJphEncoder
    >[0];
    const width = 64;
    const height = 64;
    const plane = new Uint16Array(width * height);
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        plane[y * width + x] = (x * 17 + y * 31) % 4096;
      }
    }

    const encoder = createOpenJphEncoder(factory);
    const encoded = await encoder(plane, { width, height }, { reversible: true, quality: 0 });
    expect(encoded.byteLength).toBeGreaterThan(0);

    const decoder = createOpenJphDecoder(factory);
    const decoded = toUint16Array(await decoder(encoded, {
      dataType: 'uint16',
      shape: [height, width],
      codecs: [{ name: 'experimental.openjph_htj2k', configuration: {} }],
      fillValue: 0,
    }));
    expect(decoded).toEqual(plane);
  });

  it('lossy OpenJPH quality changes encoded size on a fractal plane', async () => {
    let openjph: Record<string, unknown>;
    try {
      openjph = await import('@cornerstonejs/codec-openjph');
    } catch {
      console.warn(
        'Skipping HTJ2K lossy quality test: @cornerstonejs/codec-openjph is not installed.'
      );
      return;
    }

    const { createOpenJphEncoder } = await import('../src/htj2k-encode');
    const factory = (openjph.default ?? openjph.OpenJPHJS ?? openjph) as Parameters<
      typeof createOpenJphEncoder
    >[0];
    const width = 64;
    const height = 64;
    const plane = new Uint16Array(width * height);
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const cr = (x / width) * 3.5 - 2.5;
        const ci = (y / height) * 2.0 - 1.0;
        let zr = 0;
        let zi = 0;
        let iteration = 0;
        while (zr * zr + zi * zi <= 4 && iteration < 255) {
          const nr = zr * zr - zi * zi + cr;
          zi = 2 * zr * zi + ci;
          zr = nr;
          iteration += 1;
        }
        plane[y * width + x] = (iteration * 16) % 4096;
      }
    }

    const encoder = createOpenJphEncoder(factory);
    const high = await encoder(plane, { width, height }, { reversible: false, quality: 0.001 });
    const mid = await encoder(plane, { width, height }, { reversible: false, quality: 0.01 });
    const low = await encoder(plane, { width, height }, { reversible: false, quality: 0.1 });

    expect(high.byteLength).toBeGreaterThan(mid.byteLength);
    expect(mid.byteLength).toBeGreaterThan(low.byteLength);
  });
});

function toUint16Array(data: ArrayBuffer | ArrayBufferView): Uint16Array {
  if (data instanceof Uint16Array) {
    return data;
  }
  if (ArrayBuffer.isView(data)) {
    return new Uint16Array(data.buffer, data.byteOffset, data.byteLength / 2);
  }
  return new Uint16Array(data);
}
