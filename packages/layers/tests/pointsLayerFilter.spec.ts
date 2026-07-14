import { describe, expect, it } from 'vitest';
import { filterPreloadedBatch } from '../src/PointsLayer.js';
import {
  featureCodesSignature,
  featureFilterAwaitingRowCodes,
  hasPreloadedRowFeatureCodes,
} from '../src/pointsFeatureCodes.js';
import type { ColumnarNdarrayPointsBatch } from '../src/pointsLoader.js';

describe('PointsLayer preloaded filtering', () => {
  const batch: ColumnarNdarrayPointsBatch = {
    format: 'columnar-ndarray',
    shape: [2, 4],
    data: [Float32Array.from([0, 1, 2, 3]), Float32Array.from([10, 11, 12, 13])],
    pointCount: 4,
  };

  it('builds stable feature code signatures', () => {
    expect(featureCodesSignature(undefined)).toBe('all');
    expect(featureCodesSignature([])).toBe('none');
    expect(featureCodesSignature([2, 0, 1])).toBe('0,1,2');
  });

  it('keeps the preloaded batch visible while row feature codes are still loading', async () => {
    const filtered = await filterPreloadedBatch(batch, [1], undefined);
    expect(filtered.pointCount).toBe(4);
    expect(filtered.data[0].length).toBe(4);
  });

  it('treats empty row feature code arrays as still loading', async () => {
    expect(hasPreloadedRowFeatureCodes(undefined)).toBe(false);
    expect(hasPreloadedRowFeatureCodes(new Int32Array(0))).toBe(false);
    expect(featureFilterAwaitingRowCodes([1], new Int32Array(0))).toBe(true);

    const filtered = await filterPreloadedBatch(batch, [1], new Int32Array(0));
    expect(filtered.pointCount).toBe(4);
    expect(filtered.data[0].length).toBe(4);
  });

  it('returns an empty batch when all features are deselected without row codes', async () => {
    const filtered = await filterPreloadedBatch(batch, [], undefined);
    expect(filtered.pointCount).toBe(0);
    expect(filtered.data[0].length).toBe(0);
  });

  it('returns an empty batch when all features are deselected', async () => {
    const sourceFeatureCodes = Int32Array.from([0, 1, 0, 2]);
    const filtered = await filterPreloadedBatch(batch, [], sourceFeatureCodes);
    expect(filtered.pointCount).toBe(0);
    expect(filtered.data[0].length).toBe(0);
  });

  it('filters preloaded batches by feature codes', async () => {
    const sourceFeatureCodes = Int32Array.from([0, 1, 0, 2]);
    const filtered = await filterPreloadedBatch(batch, [1], sourceFeatureCodes);
    expect(filtered.pointCount).toBe(1);
    expect(filtered.data[0][0]).toBe(1);
    expect(filtered.data[1][0]).toBe(11);
  });
});
