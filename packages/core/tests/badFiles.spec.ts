import { describe, expect, it, vi } from 'vitest';
import { ATTRS_KEY } from '@spatialdata/zarrextra';
import { SpatialData } from '../src/store/index.js';

describe('SpatialData bad-file handling', () => {
  it('routes element construction failures through onBadFiles', () => {
    const onBadFiles = vi.fn();
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    try {
      const rootStore = {
        tree: {
          images: {
            broken_image: {
              [ATTRS_KEY]: {},
            },
          },
        },
        zarritaStore: {},
      };

      const sdata = new SpatialData(
        'https://example.com/mock.zarr',
        rootStore as any,
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
