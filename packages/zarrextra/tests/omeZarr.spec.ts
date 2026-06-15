import { describe, expect, it } from 'vitest';
import * as zarr from 'zarrita';
import { loadOmeZarrMultiscalesFromStore, registerJpeg2kCodec } from '../src';

const encoder = new TextEncoder();

function jsonBytes(value: unknown): Uint8Array {
  return encoder.encode(JSON.stringify(value));
}

function createOmeZarrStore(): Map<string, Uint8Array> {
  return new Map<string, Uint8Array>([
    [
      '/zarr.json',
      jsonBytes({
        zarr_format: 3,
        node_type: 'group',
        attributes: {
          ome: {
            multiscales: [
              {
                axes: [
                  { name: 't', type: 'time' },
                  { name: 'c', type: 'channel' },
                  { name: 'z', type: 'space' },
                  { name: 'y', type: 'space' },
                  { name: 'x', type: 'space' },
                ],
                datasets: [{ path: '0' }],
              },
            ],
          },
        },
        consolidated_metadata: {
          kind: 'inline',
          must_understand: false,
          metadata: {
            '0': {
              zarr_format: 3,
              node_type: 'array',
              shape: [1, 1, 1, 2, 2],
              data_type: 'uint8',
              chunk_grid: {
                name: 'regular',
                configuration: { chunk_shape: [1, 1, 1, 2, 2] },
              },
              chunk_key_encoding: {
                name: 'default',
                configuration: { separator: '/' },
              },
              fill_value: 0,
              codecs: [{ name: 'imagecodecs_jpeg2k', configuration: {} }],
              attributes: {},
            },
          },
        },
      }),
    ],
    ['/0/c/0/0/0/0/0', new Uint8Array([99])],
  ]);
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
});
