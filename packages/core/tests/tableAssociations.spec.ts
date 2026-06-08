import { ATTRS_KEY } from 'zarrextra';
import type { ConsolidatedStore } from 'zarrextra';
import { describe, expect, it } from 'vitest';
import { getTableKeys } from '../src/models/index.js';
import { SpatialData } from '../src/store/index.js';
import {
  createFeatureTableAlignment,
  loadAssociatedTableFeatureRows,
} from '../src/tableAssociations.js';

function createMockSpatialData() {
  const rootStore = {
    tree: {
      shapes: {
        cells: {
          [ATTRS_KEY]: {
            'encoding-type': 'ngff:shapes',
          },
        },
        cell_circles: {
          [ATTRS_KEY]: {
            'encoding-type': 'ngff:shapes',
          },
        },
        nuclei: {
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
        path_table: {
          [ATTRS_KEY]: {
            instance_key: 'cell_id',
            region: 'shapes/cells',
            region_key: 'region',
            'spatialdata-encoding-type': 'ngff:regions_table',
          },
        },
        multi_region_table: {
          [ATTRS_KEY]: {
            instance_key: 'cell_id',
            region: ['cells', 'nuclei'],
            region_key: 'region',
            'spatialdata-encoding-type': 'ngff:regions_table',
          },
        },
        xenium_table: {
          [ATTRS_KEY]: {
            instance_key: 'cell_id',
            region: ['cells', 'cell_circles'],
            region_key: 'region',
            'spatialdata-encoding-type': 'ngff:regions_table',
          },
        },
      },
    },
    zarritaStore: {},
  };

  return new SpatialData('https://example.com/mock.zarr', rootStore as ConsolidatedStore, [
    'shapes',
    'tables',
  ]);
}

describe('getTableKeys', () => {
  it('normalizes a single region to an array', () => {
    expect(
      getTableKeys({
        instance_key: 'cell_id',
        region: 'cells',
        region_key: 'region',
        'spatialdata-encoding-type': 'ngff:regions_table',
      })
    ).toEqual({
      instanceKey: 'cell_id',
      region: ['cells'],
      regionKey: 'region',
    });
  });

  it('preserves multiple regions', () => {
    expect(
      getTableKeys({
        instance_key: 'cell_id',
        region: ['cells', 'nuclei'],
        region_key: 'region',
        'spatialdata-encoding-type': 'ngff:regions_table',
      })
    ).toEqual({
      instanceKey: 'cell_id',
      region: ['cells', 'nuclei'],
      regionKey: 'region',
    });
  });
});

describe('SpatialData table associations', () => {
  it('finds tables associated with a shape key', () => {
    const sdata = createMockSpatialData();
    const matches = sdata.getAssociatedTables('shapes', 'cells');

    expect(matches.map(([name]) => name)).toEqual([
      'cells_table',
      'path_table',
      'multi_region_table',
      'xenium_table',
    ]);
  });

  it('returns the first associated table as a convenience lookup', () => {
    const sdata = createMockSpatialData();
    const match = sdata.getAssociatedTable('shapes', 'cells');

    expect(match?.[0]).toBe('cells_table');
    expect(match?.[1].getTableKeys()).toEqual({
      instanceKey: 'cell_id',
      region: ['cells'],
      regionKey: 'region',
    });
  });

  it('returns an empty list when no tables annotate an element', () => {
    const sdata = createMockSpatialData();
    expect(sdata.getAssociatedTables('shapes', 'missing')).toEqual([]);
  });
});

describe('loadAssociatedTableFeatureRows', () => {
  it('maps cell_circles features through a shared table tagged with region cells', async () => {
    const sdata = createMockSpatialData();
    const associated = sdata.getAssociatedTable('shapes', 'cell_circles');
    if (!associated) {
      throw new Error('Expected mock cell_circles association');
    }
    const [, table] = associated;
    table.loadObsIndex = async () => ['48022', '48023'];
    table.loadObsColumns = async () => [
      ['cells', 'cells'],
      ['10.5', '20.5'],
    ];

    await expect(
      loadAssociatedTableFeatureRows({
        spatialData: sdata,
        kind: 'shapes',
        key: 'cell_circles',
        extraColumnNames: ['cell_area'],
      })
    ).resolves.toMatchObject({
      rowIds: ['48022', '48023'],
    });

    const rows = await loadAssociatedTableFeatureRows({
      spatialData: sdata,
      kind: 'shapes',
      key: 'cell_circles',
      extraColumnNames: ['cell_area'],
    });
    expect(rows.rowIndexByFeatureId?.get('48022')).toBe(0);
    expect(rows.extraColumns?.[0]?.[0]).toBe('10.5');
  });
});

describe('createFeatureTableAlignment', () => {
  it('resolves rows from precomputed feature-index alignment', () => {
    const alignment = createFeatureTableAlignment({
      rowIndexByFeatureIndex: new Int32Array([1, 0, -1]),
    });

    expect(alignment.resolveRowIndex({ featureId: 'cell-a', featureIndex: 0 })).toBe(1);
    expect(alignment.resolveRowIndex({ featureId: 'cell-b', featureIndex: 1 })).toBe(0);
    expect(alignment.resolveRowIndex({ featureId: 'missing', featureIndex: 2 })).toBeUndefined();
  });

  it('uses feature-id alignment as a compatibility fallback only when index alignment is absent', () => {
    const alignment = createFeatureTableAlignment({
      rowIndexByFeatureIndex: new Int32Array([-1, -1]),
      rowIndexByFeatureId: new Map([
        ['circle-a', 1],
        ['circle-b', 0],
      ]),
    });

    expect(alignment.resolveRowIndex({ featureId: 'circle-a', featureIndex: 0 })).toBe(1);
    expect(alignment.resolveRowIndex({ featureId: 'circle-b', featureIndex: 1 })).toBe(0);
  });

  it('does not let colliding numeric feature ids override resolved feature-index alignment', () => {
    const alignment = createFeatureTableAlignment({
      rowIndexByFeatureIndex: new Int32Array([0, 1, 2]),
      rowIndexByFeatureId: new Map([
        ['1', 0],
        ['5', 1],
        ['99', 2],
      ]),
    });

    expect(alignment.resolveRowIndex({ featureId: '0', featureIndex: 0 })).toBe(0);
    expect(alignment.resolveRowIndex({ featureId: '1', featureIndex: 1 })).toBe(1);
    expect(alignment.resolveRowIndex({ featureId: '2', featureIndex: 2 })).toBe(2);
  });
});
