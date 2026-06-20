import { describe, expect, it } from 'vitest';

import { resolvePointsEncoding } from '../src/pointsLoader.js';

describe('resolvePointsEncoding', () => {
  it('prefers preloaded data when present', () => {
    expect(
      resolvePointsEncoding({ shape: [1], data: [[0], [0]] }, null, true)
    ).toBe('preloaded-columnar');
  });

  it('selects morton tiling when metadata supports row-group reads', () => {
    expect(
      resolvePointsEncoding(null, {
        kind: 'morton-points',
        parquetPath: 'points/a/points.parquet',
        axisNames: ['x', 'y'],
        featureCodeColumnName: 'feature_name_codes',
        mortonCodeColumnName: 'morton_code_2d',
        totalRows: 10,
        totalRowGroups: 1,
        maxRowsPerGroup: 10,
        supportsRowGroupRangeReads: true,
        bounds: { minX: 0, minY: 0, maxX: 10, maxY: 10 },
      }, true)
    ).toBe('morton-tiled');
  });
});
