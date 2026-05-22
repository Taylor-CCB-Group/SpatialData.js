import { describe, expect, it, vi } from 'vitest';
import SpatialDataShapesSource, {
  inferShapesGeometryKindFromParquet,
} from '../src/models/VShapesSource.js';

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

  it('loads render data for legacy 0.1 shapes without parquet geometry loading', async () => {
    const source = new SpatialDataShapesSource({
      store: {} as any,
      fileType: '.zarr',
    });

    vi.spyOn(source, 'getShapesFormatVersion').mockResolvedValue('0.1');
    vi.spyOn(source, 'loadSpatialDataElementAttrs').mockResolvedValue({
      spatialdata_attrs: {
        geos: { name: 'POINT', type: 0 },
      },
    });
    vi.spyOn(source, 'loadShapesIndex').mockResolvedValue(['legacy-1', 'legacy-2']);
    const loadPolygonShapesSpy = vi.spyOn(source, 'loadPolygonShapes');
    const loadParquetTableSpy = vi.spyOn(source, 'loadParquetTable');

    await expect(source.loadShapesRenderData('shapes/cells')).resolves.toMatchObject({
      kind: 'js-polygons',
      geometryKind: 'point',
      elementKey: 'cells',
      featureIds: ['legacy-1', 'legacy-2'],
      polygons: [],
    });
    expect(loadPolygonShapesSpy).not.toHaveBeenCalled();
    expect(loadParquetTableSpy).not.toHaveBeenCalled();
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
      schema: { fields: [{ name: 'geometry' }], metadata: new Map() },
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
      geometryKind: 'polygon',
      elementKey: 'cells',
      featureIds: ['cell-1', 'cell-2'],
    });
  });

  it('loads render data for circle shapes (e.g. Xenium cell_circles)', async () => {
    const source = new SpatialDataShapesSource({
      store: {} as any,
      fileType: '.zarr',
    });

    vi.spyOn(source, 'getShapesFormatVersion').mockResolvedValue('0.2');
    vi.spyOn(source, 'loadShapesIndex').mockResolvedValue(['cell-1', 'cell-2']);
    vi.spyOn(source, 'loadCircleShapes').mockResolvedValue({
      shape: [2, 2],
      data: [new Float32Array([0, 2]), new Float32Array([0, 2])],
    });
    vi.spyOn(source, 'loadNumeric').mockResolvedValue({
      shape: [2],
      data: new Float32Array([1, 1.5]),
      stride: [1],
    });
    vi.spyOn(source, 'loadParquetTable').mockResolvedValue({
      numRows: 2,
      schema: { fields: [{ name: 'geometry' }, { name: 'radius' }], metadata: new Map() },
      getChild: () => undefined,
    } as any);

    await expect(source.loadShapesRenderData('shapes/cell_circles')).resolves.toMatchObject({
      kind: 'wkb-parquet',
      geometryKind: 'circle',
      elementKey: 'cell_circles',
      featureIds: ['cell-1', 'cell-2'],
      circles: {
        positions: [new Float32Array([0, 2]), new Float32Array([0, 2])],
        radii: new Float32Array([1, 1.5]),
      },
    });
  });

  it('detects point landmarks from geopandas geo parquet metadata', async () => {
    const geoMetadata = JSON.stringify({
      primary_column: 'geometry',
      columns: {
        geometry: {
          encoding: 'WKB',
          geometry_types: ['Point'],
        },
      },
      version: '1.0.0',
    });

    const arrowTable = {
      schema: {
        fields: [{ name: 'geometry' }],
        metadata: new Map([['geo', geoMetadata]]),
      },
    } as any;

    expect(inferShapesGeometryKindFromParquet(arrowTable)).toBe('point');
  });

  it('loads render data for point landmarks (e.g. Xenium xenium_landmarks)', async () => {
    const source = new SpatialDataShapesSource({
      store: {} as any,
      fileType: '.zarr',
    });

    const geoMetadata = JSON.stringify({
      primary_column: 'geometry',
      columns: {
        geometry: {
          encoding: 'WKB',
          geometry_types: ['Point'],
        },
      },
      version: '1.0.0',
    });

    vi.spyOn(source, 'getShapesFormatVersion').mockResolvedValue('0.2');
    vi.spyOn(source, 'loadShapesIndex').mockResolvedValue(['landmark-a', 'landmark-b']);
    vi.spyOn(source, 'loadCircleShapes').mockResolvedValue({
      shape: [2, 2],
      data: [new Float32Array([100, 200]), new Float32Array([50, 60])],
    });
    vi.spyOn(source, 'loadParquetTable').mockResolvedValue({
      numRows: 2,
      schema: {
        fields: [{ name: 'geometry' }],
        metadata: new Map([['geo', geoMetadata]]),
      },
      getChild: () => undefined,
    } as any);
    const loadNumericSpy = vi.spyOn(source, 'loadNumeric');

    await expect(source.loadShapesRenderData('shapes/xenium_landmarks')).resolves.toMatchObject({
      kind: 'wkb-parquet',
      geometryKind: 'point',
      elementKey: 'xenium_landmarks',
      featureIds: ['landmark-a', 'landmark-b'],
      circles: {
        positions: [new Float32Array([100, 200]), new Float32Array([50, 60])],
      },
    });
    expect(loadNumericSpy).not.toHaveBeenCalled();
  });

  it('detects circle shapes from a parquet radius column', async () => {
    const source = new SpatialDataShapesSource({
      store: {} as any,
      fileType: '.zarr',
    });

    vi.spyOn(source, 'getShapesFormatVersion').mockResolvedValue('0.2');
    vi.spyOn(source, 'loadParquetTable').mockResolvedValue({
      schema: { fields: [{ name: 'geometry' }, { name: 'radius' }], metadata: new Map() },
    } as any);

    await expect(source.getShapesGeometryKind('shapes/cell_circles')).resolves.toBe('circle');
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
      schema: { fields: [{ name: 'geometry' }], metadata: new Map() },
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
