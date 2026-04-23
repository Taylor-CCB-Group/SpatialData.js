import { assert, describe, expect, it, vi } from 'vitest';
import { ATTRS_KEY } from '@spatialdata/zarrextra';
import { SpatialData } from '../src/store/index.js';

function createMockSpatialData() {
  const rootStore = {
    tree: {
      tables: {
        cells_table: {
          [ATTRS_KEY]: {
            instance_key: 'cell_id',
            region: 'cells',
            region_key: 'region',
            'spatialdata-encoding-type': 'ngff:regions_table',
          },
          obs: {},
        },
      },
    },
    zarritaStore: {},
  };

  return new SpatialData('https://example.com/mock.zarr', rootStore as any, ['tables']);
}

describe('TableElement direct table reads', () => {
  it('loads obs indices via the direct table source without touching anndata.js', async () => {
    const sdata = createMockSpatialData();
    assert(sdata.tables, 'sdata.tables on mock object should be truthy');
    const table = sdata.tables.cells_table;

    const getAnnDataSpy = vi.spyOn(table, 'getAnnDataJS');

    const loadObsIndex = vi.fn().mockResolvedValue(['cell-1', 'cell-2']);
    (table as any).tableSource = {
      loadObsIndex,
    };

    await expect(table.loadObsIndex()).resolves.toEqual(['cell-1', 'cell-2']);
    expect(loadObsIndex).toHaveBeenCalledWith('tables/cells_table');
    expect(getAnnDataSpy).not.toHaveBeenCalled();
  });

  it('loads obs columns via the direct table source without touching anndata.js', async () => {
    const sdata = createMockSpatialData();
    assert(sdata.tables, 'sdata.tables on mock object should be truthy');
    const table = sdata.tables.cells_table;

    const getAnnDataSpy = vi.spyOn(table, 'getAnnDataJS');

    const loadObsColumns = vi.fn().mockResolvedValue([['cells', 'cells']]);
    (table as any).tableSource = {
      loadObsColumns,
    };

    await expect(table.loadObsColumns(['region'])).resolves.toEqual([['cells', 'cells']]);
    expect(loadObsColumns).toHaveBeenCalledWith(['tables/cells_table/obs/region']);
    expect(getAnnDataSpy).not.toHaveBeenCalled();
  });

  it('preserves non-string obs column values until the consumer formats them', async () => {
    const sdata = createMockSpatialData();
    assert(sdata.tables, 'sdata.tables on mock object should be truthy');
    const table = sdata.tables.cells_table;

    const loadObsColumns = vi.fn().mockResolvedValue([[1, 2, 3]]);
    (table as any).tableSource = {
      loadObsColumns,
    };

    await expect(table.loadObsColumns(['score'])).resolves.toEqual([[1, 2, 3]]);
  });
});
