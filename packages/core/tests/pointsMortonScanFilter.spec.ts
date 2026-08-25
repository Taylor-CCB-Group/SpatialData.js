import { tableFromArrays } from 'apache-arrow';
import { describe, expect, it } from 'vitest';
import { Float32PointBuffer, scanMortonTableInBounds } from '../src/workers/pointsScan.js';

/**
 * The tiled scan filters by feature code using a column it looks up by name. If
 * that column is not in the decoded chunk the scan cannot honour the filter at
 * all — and the failure mode matters, because nothing downstream checks.
 *
 * Passing every row means one selected gene renders as the whole dataset, in the
 * selection's colour, with no error logged. Matching nothing is also wrong, but
 * it shows up as "my gene has no points" rather than as plausible-looking data.
 */

function scan(columns: Record<string, unknown>, over: Record<string, unknown> = {}) {
  const xs = new Float32PointBuffer();
  const ys = new Float32PointBuffer();
  const zs = new Float32PointBuffer();
  scanMortonTableInBounds({
    table: tableFromArrays(columns as never),
    rowGroupIndex: 1, // past the sentinel window, so no rows are skipped for it
    bounds: { minX: -1e6, minY: -1e6, maxX: 1e6, maxY: 1e6 },
    axisNames: ['x', 'y'],
    mortonCodeColumnName: 'morton',
    xs,
    ys,
    zs,
    ...over,
  } as never);
  return Array.from(xs.toArray());
}

const withCodes = {
  x: Float32Array.from([0, 1, 2, 3]),
  y: Float32Array.from([0, 1, 2, 3]),
  morton: Int32Array.from([10, 11, 12, 13]),
  feature_name_codes: Int32Array.from([0, 1, 0, 2]),
};
const withoutCodes = {
  x: withCodes.x,
  y: withCodes.y,
  morton: withCodes.morton,
};

describe('morton scan — feature filter', () => {
  it('keeps only the requested codes when the column is present', () => {
    expect(
      scan(withCodes, { featureCodeColumnName: 'feature_name_codes', featureCodes: [0] })
    ).toEqual([0, 2]);
  });

  it('matches nothing when the filter cannot be honoured', () => {
    // Column named but absent from the decoded chunk.
    expect(
      scan(withoutCodes, { featureCodeColumnName: 'feature_name_codes', featureCodes: [0] })
    ).toEqual([]);
    // Filter requested with no column name at all.
    expect(scan(withoutCodes, { featureCodes: [0] })).toEqual([]);
  });

  it('still returns every in-bounds row when no filter was requested', () => {
    expect(scan(withoutCodes)).toEqual([0, 1, 2, 3]);
    expect(scan(withCodes, { featureCodeColumnName: 'feature_name_codes' })).toEqual([0, 1, 2, 3]);
  });
});
