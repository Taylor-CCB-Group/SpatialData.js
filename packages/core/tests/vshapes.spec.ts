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
});
