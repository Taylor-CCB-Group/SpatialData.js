import { describe, expect, it, vi } from 'vitest';
import { ATTRS_KEY } from '@spatialdata/zarrextra';
import type { ConsolidatedStore } from '@spatialdata/zarrextra';
import type * as zarr from 'zarrita';
import { SpatialData } from '../src/store/index.js';

describe('SpatialData bad-file handling', () => {
  it('routes element construction failures through onBadFiles', () => {
    const onBadFiles = vi.fn();
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    try {
      const readableStore: zarr.Readable = {
        async get() {
          return undefined;
        },
      };
      const rootStore: ConsolidatedStore = {
        tree: {
          images: {
            broken_image: {
              [ATTRS_KEY]: {},
            },
          },
        },
        zarritaStore: {
          ...readableStore,
          contents() {
            return [];
          },
        },
      };

      const sdata = new SpatialData(
        'https://example.com/mock.zarr',
        rootStore,
        ['images'],
        onBadFiles
      );

      expect(sdata.images).toEqual({});
      expect(onBadFiles).toHaveBeenCalledTimes(1);
      expect(onBadFiles).toHaveBeenCalledWith(
        'images/broken_image',
        expect.any(Error)
      );
      expect(consoleErrorSpy).not.toHaveBeenCalled();
    } finally {
      consoleErrorSpy.mockRestore();
    }
  });
});
