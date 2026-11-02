import { describe, expect, it } from 'vitest';
import { ATTRS_KEY } from 'zarrextra';
import { ImageElement } from '../src/models/index.js';
import { parseTransforms } from '../src/transformations/transformations.js';

function createCyxImage(
  datasetScale: number[],
  axes: unknown[] = [
    { name: 'c', type: 'channel' },
    { name: 'y', type: 'space' },
    { name: 'x', type: 'space' },
  ]
) {
  const tree = {
    images: {
      img: {
        [ATTRS_KEY]: {
          multiscales: [
            {
              datasets: [
                { path: '0', coordinateTransformations: [{ type: 'scale', scale: datasetScale }] },
              ],
              axes,
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

  it('keeps the scale of x/y axes that declare no type', () => {
    const image = createCyxImage([4, 2], [{ name: 'y' }, { name: 'x' }]);
    const { dataset } = image.getTransformationForLevel(0) ?? {};

    expect(dataset?.toMatrix().transformPoint([1, 1, 0])).toEqual([2, 4, 0]);
  });
});

describe('parseTransforms with default input axes', () => {
  const yx = [
    { name: 'y', type: 'space' as const },
    { name: 'x', type: 'space' as const },
  ];

  it('does not apply the original axis order after a mapAxis reorder', () => {
    const matrix = parseTransforms(
      [
        { type: 'mapAxis', mapAxis: [1, 0] },
        { type: 'scale', scale: [3, 5] },
      ],
      yx
    ).toMatrix();

    // After the swap the first value belongs to x, as it did before axes were threaded through.
    expect(matrix.transformPoint([1, 1, 0])).toEqual([3, 5, 0]);
  });
});
