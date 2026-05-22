import { describe, expect, it } from 'vitest';
import { ATTRS_KEY } from '@spatialdata/zarrextra';
import { SpatialData } from '../src/store/index.js';
import { loadFeatureRowIndexByFeatureIndex } from '../src/tableAssociations.js';

function createMockSpatialData() {
  const rootStore = {
    tree: {
      shapes: {
        cells: {
          [ATTRS_KEY]: {
            'encoding-type': 'ngff:shapes',
          },
        },
      },
      tables: {
        cells_table: {
          [ATTRS_KEY]: {
            instance_key: 'cell_id',
            region: 'cells',
            region_key: 'region',
            'spatialdata-encoding-type': 'ngff:regions_table',
          },
        },
      },
    },
    zarritaStore: {},
  };

  return new SpatialData('https://example.com/mock.zarr', rootStore as any, ['shapes', 'tables']);
}

describe('loadFeatureRowIndexByFeatureIndex', () => {
  it('maps feature ids through the associated table index', async () => {
    const sdata = createMockSpatialData();
    const [, table] = sdata.getAssociatedTable('shapes', 'cells')!;
    table.loadObsIndex = async () => ['cell-3', 'cell-1', 'cell-2'];
    table.loadObsColumns = async () => [['cells', 'cells', 'cells']];

    await expect(
      loadFeatureRowIndexByFeatureIndex({
        spatialData: sdata,
        kind: 'shapes',
        key: 'cells',
        featureIds: ['cell-1', 'cell-2', 'missing'],
      })
    ).resolves.toEqual(new Int32Array([1, 2, -1]));
  });

  it('returns sentinel values when no associated table exists', async () => {
    const sdata = createMockSpatialData();

    await expect(
      loadFeatureRowIndexByFeatureIndex({
        spatialData: sdata,
        kind: 'shapes',
        key: 'missing',
        featureIds: ['cell-1'],
      })
    ).resolves.toEqual(new Int32Array([-1]));
  });

  it('enriches ShapesElement render data with shared row alignment', async () => {
    const sdata = createMockSpatialData();
    const shapeElement = sdata.shapes!.cells as any;
    const [, table] = sdata.getAssociatedTable('shapes', 'cells')!;
    table.loadObsIndex = async () => ['cell-2', 'cell-1'];
    table.loadObsColumns = async () => [['cells', 'cells']];
    shapeElement.vShapes.loadShapesRenderData = async () => ({
      kind: 'wkb-parquet',
      geometryKind: 'polygon',
      elementKey: 'cells',
      featureIds: ['cell-1', 'cell-2'],
      polygons: [
        [[[0, 0], [1, 0], [1, 1], [0, 0]]],
        [[[2, 2], [3, 2], [3, 3], [2, 2]]],
      ],
      rowIndexByFeatureIndex: new Int32Array(2).fill(-1),
    });

    await expect(shapeElement.loadRenderData()).resolves.toMatchObject({
      featureIds: ['cell-1', 'cell-2'],
      rowIndexByFeatureIndex: new Int32Array([1, 0]),
    });
  });
});
