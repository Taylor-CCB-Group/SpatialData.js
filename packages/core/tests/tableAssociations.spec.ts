import { describe, expect, it } from 'vitest';
import { ATTRS_KEY } from '@spatialdata/zarrextra';
import { getTableKeys } from '../src/models/index.js';
import { SpatialData } from '../src/store/index.js';

function createMockSpatialData() {
  const rootStore = {
    tree: {
      shapes: {
        cells: {
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
      },
    },
    zarritaStore: {},
  };

  return new SpatialData('https://example.com/mock.zarr', rootStore as any, ['shapes', 'tables']);
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
