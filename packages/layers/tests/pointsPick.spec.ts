import { describe, expect, it } from 'vitest';
import type { ColumnarNdarrayPointsBatch } from '../src/pointsLoader.js';
import {
  formatPointsTooltip,
  isPointsPickObject,
  type PointsPickObject,
  pointsPickObjectFromDeckData,
} from '../src/pointsPick.js';
import { buildPointsDeckData } from '../src/pointsRenderAttributes.js';

function batch(): ColumnarNdarrayPointsBatch {
  return {
    format: 'columnar-ndarray',
    // x, y, z columns for three points.
    data: [
      [10, 20, 30],
      [11, 21, 31],
      [0.5, 1.5, 2.5],
    ],
    shape: [3, 3],
    featureCodes: [4, 0, 7],
  };
}

describe('pointsPickObjectFromDeckData', () => {
  it('reads the picked row back out of the binary attributes deck drew', () => {
    const data = buildPointsDeckData(batch(), true, true);

    const pick = pointsPickObjectFromDeckData(data, 1);

    expect(pick).toEqual({
      kind: 'spatialdata-points',
      pointIndex: 1,
      position: [20, 21, 1.5],
      featureCode: 0,
    });
    expect(isPointsPickObject(pick)).toBe(true);
  });

  it('refuses a pick-shaped object without a usable position', () => {
    // A narrowed pick gets destructured, so the guard has to mean it.
    expect(isPointsPickObject({ kind: 'spatialdata-points', pointIndex: 0 })).toBe(false);
    expect(
      isPointsPickObject({ kind: 'spatialdata-points', pointIndex: 0, position: [1, 2] })
    ).toBe(false);
  });

  it('omits the feature code when the batch carries none', () => {
    const { featureCodes: _dropped, ...withoutCodes } = batch();
    const data = buildPointsDeckData(withoutCodes, false, true);

    expect(pointsPickObjectFromDeckData(data, 0)?.featureCode).toBeUndefined();
  });

  it('reads the code from the CPU lane when the layer is not colouring by feature', () => {
    const data = buildPointsDeckData(batch(), true, false);

    expect(Reflect.get(data.attributes, 'getFeatureCode')).toBeUndefined();
    expect(pointsPickObjectFromDeckData(data, 2)?.featureCode).toBe(7);
  });

  it('returns nothing for an out-of-range index or foreign data', () => {
    const data = buildPointsDeckData(batch(), true, true);

    expect(pointsPickObjectFromDeckData(data, 3)).toBeUndefined();
    expect(pointsPickObjectFromDeckData(data, -1)).toBeUndefined();
    expect(pointsPickObjectFromDeckData([{ position: [1, 2] }], 0)).toBeUndefined();
  });
});

describe('formatPointsTooltip', () => {
  const pick = {
    kind: 'spatialdata-points',
    pointIndex: 1,
    position: [1.23456789, 2, 0],
    featureCode: 4,
  } satisfies PointsPickObject;

  it('leads with the feature name and titles the tooltip with it', () => {
    const tooltip = formatPointsTooltip(pick, {
      featureKey: 'feature_name',
      entry: { name: 'EPCAM' },
    });

    expect(tooltip.title).toBe('EPCAM');
    expect(tooltip.items).toEqual([
      { label: 'feature_name', value: 'EPCAM' },
      { label: 'x', value: '1.23457' },
      { label: 'y', value: '2' },
    ]);
  });

  it('falls back to the raw code while the catalog has no entry for it', () => {
    const tooltip = formatPointsTooltip(pick, { featureKey: 'gene' });

    expect(tooltip.title).toBeUndefined();
    expect(tooltip.items[0]).toEqual({ label: 'gene', value: 'code 4' });
  });

  it('shows z only when the element is drawn in 3D', () => {
    const flat = formatPointsTooltip(pick);
    const volumetric = formatPointsTooltip({ ...pick, position: [1, 2, 3] });

    expect(flat.items.map((item) => item.label)).not.toContain('z');
    expect(volumetric.items.at(-1)).toEqual({ label: 'z', value: '3' });
  });
});
