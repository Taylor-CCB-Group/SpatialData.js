import { describe, expect, it } from 'vitest';
import { ATTRS_KEY } from 'zarrextra';
import { ImageElement } from '../src/models/index.js';

function createCyxImage(datasetScale: number[]) {
  const tree = {
    images: {
      img: {
        [ATTRS_KEY]: {
          multiscales: [
            {
              datasets: [
                { path: '0', coordinateTransformations: [{ type: 'scale', scale: datasetScale }] },
              ],
              axes: [
                { name: 'c', type: 'channel' },
                { name: 'y', type: 'space' },
                { name: 'x', type: 'space' },
              ],
            },
          ],
        },
      },
    },
  };
  return new ImageElement({
    sdata: {
      source: 'test://sdata.zarr',
      rootStore: { tree, zarritaStore: { get: async () => undefined, contents: () => [] } },
    },
    name: 'images',
    key: 'img',
  });
}

describe('getTransformationForLevel', () => {
  it('applies a (c,y,x) level scale to the spatial axes by name', () => {
    const { dataset } = createCyxImage([1, 4, 2]).getTransformationForLevel(0) ?? {};

    // x is scaled by 2 and y by 4; the leading channel factor must not leak into x.
    expect(dataset?.toMatrix().transformPoint([1, 1, 0])).toEqual([2, 4, 0]);
  });
});
