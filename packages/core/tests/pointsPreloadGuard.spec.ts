import { tableFromArrays } from 'apache-arrow';
import { describe, expect, it, vi } from 'vitest';
import SpatialDataPointsSource from '../src/models/VPointsSource.js';
import { POINTS_PRELOAD_MAX_ROWS, preloadedColumnarPointCount } from '../src/pointsLimits.js';

describe('points preload cap', () => {
  it('loads a capped subset when parquet row count exceeds the cap', async () => {
    const source = new SpatialDataPointsSource({
      store: { get: async () => null },
      fileType: '.zarr',
    });

    vi.spyOn(source, 'loadSpatialDataElementAttrs').mockResolvedValue({
      'encoding-type': 'ngff:points',
      axes: ['x', 'y'],
      spatialdata_attrs: {
        feature_key: 'feature_name',
        version: '0.2',
      },
    });
    vi.spyOn(source, 'loadParquetDatasetMetadata').mockResolvedValue({
      totalNumRows: POINTS_PRELOAD_MAX_ROWS + 1,
      totalNumRowGroups: 1,
      numRowsByPart: [POINTS_PRELOAD_MAX_ROWS + 1],
      numRowGroupsByPart: [1],
      numRowsPerGroupByPart: [POINTS_PRELOAD_MAX_ROWS + 1],
      rowGroupRows: [POINTS_PRELOAD_MAX_ROWS + 1],
      schema: null,
      parts: [],
    });
    vi.spyOn(source, 'resolveParquetRowCount').mockResolvedValue(POINTS_PRELOAD_MAX_ROWS + 1);

    const cappedTable = tableFromArrays({
      x: new Float32Array(POINTS_PRELOAD_MAX_ROWS),
      y: new Float32Array(POINTS_PRELOAD_MAX_ROWS),
      feature_name: new Array(POINTS_PRELOAD_MAX_ROWS).fill('gene'),
    });
    vi.spyOn(source, 'loadParquetTableCapped').mockResolvedValue({
      table: cappedTable,
      totalRows: POINTS_PRELOAD_MAX_ROWS + 1,
      truncated: true,
    });

    const result = await source.loadPoints('points/transcripts');
    expect(preloadedColumnarPointCount(result.shape, result.data)).toBe(POINTS_PRELOAD_MAX_ROWS);
    expect(result.totalRowCount).toBe(POINTS_PRELOAD_MAX_ROWS + 1);
    expect(result.preloadTruncated).toBe(true);
  });
});
