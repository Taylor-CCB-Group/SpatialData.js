import { describe, expect, it } from 'vitest';
import { filterColumnarByFeatureCodesInWorker, setPointsWorkerDefaultEnabled } from '../src/workers/pointsWorkerClient.js';
import { filterColumnarByFeatureCodes as filterSync } from '../src/pointsTiling.js';

describe('points worker client', () => {
  it('falls back to main-thread filtering when the worker is disabled', async () => {
    setPointsWorkerDefaultEnabled(false);
    const data = {
      shape: [2, 4] as [number, number],
      data: [
        Float32Array.from([0, 1, 2, 3]),
        Float32Array.from([0, 1, 2, 3]),
      ],
    };
    const sourceFeatureCodes = Int32Array.from([0, 1, 0, 2]);
    const filtered = await filterColumnarByFeatureCodesInWorker(data, [1], sourceFeatureCodes);
    const expected = filterSync(data, [1], sourceFeatureCodes);
    expect(filtered.shape).toEqual(expected.shape);
    expect(Array.from(filtered.data[0])).toEqual(Array.from(expected.data[0]));
    expect(Array.from(filtered.data[1])).toEqual(Array.from(expected.data[1]));
  });
});
