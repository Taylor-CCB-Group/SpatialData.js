import { describe, expect, it, vi } from 'vitest';
import { tableFromArrays } from 'apache-arrow';
import SpatialDataPointsSource from '../src/models/VPointsSource.js';
import * as pointsWorkerClient from '../src/workers/pointsWorkerClient.js';

describe('points preload read strategy', () => {
  it('does not prefetch row-group bytes for geometry preload', async () => {
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
    vi.spyOn(source, 'resolveParquetRowCount').mockResolvedValue(100);
    vi.spyOn(source, 'canLoadParquetRowGroups').mockResolvedValue(true);

    const rowGroupBytesSpy = vi.spyOn(source, 'readParquetRowGroupsBytesCapped');
    const payloadSpy = vi.spyOn(source, 'readParquetWorkerPayload');

    vi.spyOn(pointsWorkerClient, 'isPointsWorkerEnabled').mockReturnValue(true);
    vi.spyOn(pointsWorkerClient, 'decodeParquetGeometryCappedInWorker').mockResolvedValue({
      shape: [2, 100],
      data: [new Float32Array(100), new Float32Array(100)],
    });

    await source.loadPoints('points/transcripts');

    expect(rowGroupBytesSpy).not.toHaveBeenCalled();
    expect(payloadSpy).toHaveBeenCalledWith('points/transcripts/points.parquet', { maxRows: 100 });
    expect(payloadSpy.mock.calls[0]?.[1]?.includeRowGroups).not.toBe(true);
  });

  it('uses full-file capped decode for preload fallback, not row groups', async () => {
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
    vi.spyOn(source, 'resolveParquetRowCount').mockResolvedValue(100);
    vi.spyOn(source, 'canLoadParquetRowGroups').mockResolvedValue(true);
    vi.spyOn(pointsWorkerClient, 'isPointsWorkerEnabled').mockReturnValue(false);

    const cappedSpy = vi.spyOn(source, 'loadParquetTableCapped').mockResolvedValue({
      table: tableFromArrays({
        x: new Float32Array(100),
        y: new Float32Array(100),
      }),
      totalRows: 100,
      truncated: false,
    });

    await source.loadPoints('points/transcripts');

    expect(cappedSpy).toHaveBeenCalledWith(
      'points/transcripts/points.parquet',
      ['x', 'y'],
      100
    );
  });
});
