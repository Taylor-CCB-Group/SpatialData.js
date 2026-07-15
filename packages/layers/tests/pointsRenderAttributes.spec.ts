import { describe, expect, it } from 'vitest';
import type { ColumnarNdarrayPointsBatch } from '../src/pointsLoader.js';
import { buildPointsAttributes } from '../src/pointsRenderAttributes.js';

function batch(overrides: Partial<ColumnarNdarrayPointsBatch>): ColumnarNdarrayPointsBatch {
  return {
    format: 'columnar-ndarray',
    data: [new Float32Array([0, 1, 2]), new Float32Array([10, 11, 12])],
    shape: [2, 3],
    pointCount: 3,
    ...overrides,
  };
}

describe('buildPointsAttributes', () => {
  it('interleaves x/y into [x, y, 0] triples in 2D', () => {
    const attrs = buildPointsAttributes(batch({}), false);
    expect(attrs.length).toBe(3);
    expect(Array.from(attrs.positions)).toEqual([0, 10, 0, 1, 11, 0, 2, 12, 0]);
  });

  it('includes z only when use3d and a z column exist', () => {
    const b = batch({
      data: [new Float32Array([0, 1]), new Float32Array([10, 11]), new Float32Array([100, 101])],
      shape: [3, 2],
      pointCount: 2,
    });
    expect(Array.from(buildPointsAttributes(b, true).positions)).toEqual([0, 10, 100, 1, 11, 101]);
    // use3d=false flattens z to 0 even when a z column is present.
    expect(Array.from(buildPointsAttributes(b, false).positions)).toEqual([0, 10, 0, 1, 11, 0]);
  });

  it('exposes feature codes as a float attribute aligned with points', () => {
    const attrs = buildPointsAttributes(batch({ featureCodes: new Int32Array([7, 3, 7]) }), false);
    expect(attrs.featureCodes).toBeInstanceOf(Float32Array);
    expect(Array.from(attrs.featureCodes ?? [])).toEqual([7, 3, 7]);
  });

  it('omits feature codes when the batch has none', () => {
    expect(buildPointsAttributes(batch({}), false).featureCodes).toBeUndefined();
  });

  it('memoizes per batch identity so deck receives a stable buffer', () => {
    const b = batch({});
    const first = buildPointsAttributes(b, false);
    expect(buildPointsAttributes(b, false).positions).toBe(first.positions);
    // A different use3d flag invalidates the cached entry.
    expect(buildPointsAttributes(b, true).positions).not.toBe(first.positions);
  });
});
