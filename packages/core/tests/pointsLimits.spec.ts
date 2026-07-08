import { describe, expect, it } from 'vitest';
import { applyRenderCapToColumnar } from '../src/pointsLimits.js';

describe('applyRenderCapToColumnar', () => {
  it('returns the batch untouched when under the cap', () => {
    const batch = {
      shape: [2, 3],
      data: [new Float32Array([0, 1, 2]), new Float32Array([0, 1, 2])],
      featureCodes: new Int32Array([9, 8, 7]),
    };
    expect(applyRenderCapToColumnar(batch, 10)).toBe(batch);
  });

  it('truncates feature codes in lockstep with geometry', () => {
    const batch = {
      shape: [2, 4],
      data: [new Float32Array([0, 1, 2, 3]), new Float32Array([0, 10, 20, 30])],
      featureCodes: new Int32Array([5, 6, 7, 8]),
    };
    const capped = applyRenderCapToColumnar(batch, 2);
    expect(capped.shape).toEqual([2, 2]);
    expect(Array.from(capped.data[0])).toEqual([0, 1]);
    expect(Array.from(capped.featureCodes ?? [])).toEqual([5, 6]);
  });

  it('leaves codes absent when the batch has none', () => {
    const batch = {
      shape: [2, 4],
      data: [new Float32Array([0, 1, 2, 3]), new Float32Array([0, 10, 20, 30])],
    };
    const capped = applyRenderCapToColumnar(batch, 2);
    expect(capped.featureCodes).toBeUndefined();
    expect(capped.shape).toEqual([2, 2]);
  });
});
