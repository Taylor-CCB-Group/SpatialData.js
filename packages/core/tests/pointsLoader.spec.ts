import { describe, expect, it } from 'vitest';

import { createMortonTiledPointsLoader, resolvePointsEncoding } from '../src/pointsLoader.js';
import type { PointsElement } from '../src/models/index.js';

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

describe('createMortonTiledPointsLoader', () => {
  it('uses columnar shape[1] as point count, not shape[0] axis count', async () => {
    const element = {
      async loadPointsInBounds() {
        return {
          shape: [2, 1_000],
          data: [new Float64Array(1_000), new Float64Array(1_000)],
          bounds: { minX: 0, minY: 0, maxX: 10, maxY: 10 },
          loadMode: 'row-groups',
        };
      },
    } as unknown as PointsElement;

    const loader = createMortonTiledPointsLoader(element, {
      kind: 'morton-points',
      parquetPath: 'points/a/points.parquet',
      axisNames: ['x', 'y'],
      featureCodeColumnName: 'feature_name_codes',
      mortonCodeColumnName: 'morton_code_2d',
      totalRows: 1_000,
      totalRowGroups: 1,
      maxRowsPerGroup: 1_000,
      supportsRowGroupRangeReads: true,
      bounds: { minX: 0, minY: 0, maxX: 10, maxY: 10 },
    });

    const batch = await loader.loadInBounds({
      bounds: { minX: 0, minY: 0, maxX: 10, maxY: 10 },
    });
    expect(batch?.pointCount).toBe(1_000);
  });
});
