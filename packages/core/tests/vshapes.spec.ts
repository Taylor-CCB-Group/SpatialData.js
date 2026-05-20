import { describe, expect, it, vi } from 'vitest';
import SpatialDataShapesSource from '../src/models/VShapesSource.js';

describe('SpatialDataShapesSource', () => {
  it('loads feature ids from parquet for ngff:shapes 0.3 metadata', async () => {
    const source = new SpatialDataShapesSource({
      store: {} as any,
      fileType: '.zarr',
    });

    vi.spyOn(source, 'loadSpatialDataElementAttrs').mockResolvedValue({
      'encoding-type': 'ngff:shapes',
      spatialdata_attrs: {
        version: '0.3',
      },
    });

    vi.spyOn(source, 'loadParquetTableIndex').mockResolvedValue({
      toArray: () => ['cell-1', 'cell-2'],
    } as any);

    await expect(source.loadShapesIndex('shapes/cells')).resolves.toEqual(['cell-1', 'cell-2']);
  });

  it('keeps using the legacy zarr path for 0.1 point-style shapes', async () => {
    const source = new SpatialDataShapesSource({
      store: {} as any,
      fileType: '.zarr',
    });

    vi.spyOn(source, 'loadSpatialDataElementAttrs').mockResolvedValue({
      'encoding-type': 'ngff:shapes',
      spatialdata_attrs: {
        version: '0.1',
        geos: {
          name: 'POINT',
          type: 0,
        },
      },
    });

    const loadColumnSpy = vi.spyOn(source, '_loadColumn').mockResolvedValue(['legacy-1']);
    const loadParquetTableIndexSpy = vi.spyOn(source, 'loadParquetTableIndex');

    await expect(source.loadShapesIndex('shapes/cells')).resolves.toEqual(['legacy-1']);
    expect(loadColumnSpy).toHaveBeenCalledWith('shapes/cells/Index');
    expect(loadParquetTableIndexSpy).not.toHaveBeenCalled();
  });

  it('loads render data with aligned feature ids and polygons', async () => {
    const source = new SpatialDataShapesSource({
      store: {} as any,
      fileType: '.zarr',
    });

    vi.spyOn(source, 'getShapesFormatVersion').mockResolvedValue('0.2');
    vi.spyOn(source, 'loadShapesIndex').mockResolvedValue(['cell-1', 'cell-2']);
    vi.spyOn(source, 'loadParquetTable').mockResolvedValue({
      numRows: 2,
      getChild: () => undefined,
    } as any);
    vi.spyOn(source, 'loadPolygonShapes').mockResolvedValue({
      shape: [2, null],
      data: [
        [[[0, 0], [1, 0], [1, 1], [0, 0]]],
        [[[2, 2], [3, 2], [3, 3], [2, 2]]],
      ],
    });

    await expect(source.loadShapesRenderData('shapes/cells')).resolves.toMatchObject({
      kind: 'wkb-parquet',
      elementKey: 'cells',
      featureIds: ['cell-1', 'cell-2'],
    });
  });

  it('fails clearly when feature ids and polygons are misaligned', async () => {
    const source = new SpatialDataShapesSource({
      store: {} as any,
      fileType: '.zarr',
    });

    vi.spyOn(source, 'getShapesFormatVersion').mockResolvedValue('0.2');
    vi.spyOn(source, 'loadShapesIndex').mockResolvedValue(['cell-1']);
    vi.spyOn(source, 'loadParquetTable').mockResolvedValue({
      numRows: 2,
      getChild: () => undefined,
    } as any);
    vi.spyOn(source, 'loadPolygonShapes').mockResolvedValue({
      shape: [2, null],
      data: [
        [[[0, 0], [1, 0], [1, 1], [0, 0]]],
        [[[2, 2], [3, 2], [3, 3], [2, 2]]],
      ],
    });

    await expect(source.loadShapesRenderData('shapes/cells')).rejects.toThrow(
      /Feature id count \(1\) did not match polygon count \(2\)/
    );
  });
});
