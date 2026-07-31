import { assert, describe, expect, it, vi } from 'vitest';
import { ATTRS_KEY, ZARRAY_KEY } from 'zarrextra';
import { SpatialData } from '../src/store/index.js';

function createMockSpatialData(obs: Record<string | symbol, unknown> = {}) {
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
          obs,
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

describe('TableElement obs column names', () => {
  it('omits the unnamed index that AnnData stores as `_index` (blobs fixture shape)', () => {
    const sdata = createMockSpatialData({
      [ATTRS_KEY]: { _index: '_index', 'encoding-type': 'dataframe' },
      _index: {},
      instance_id: {},
      region: {},
    });
    assert(sdata.tables, 'sdata.tables on mock object should be truthy');
    const table = sdata.tables.cells_table;

    expect(table.getObsIndexColumnName()).toBe('_index');
    expect(table.getObsColumnNames()).toEqual(['instance_id', 'region']);
  });

  it('omits a named index too', () => {
    const sdata = createMockSpatialData({
      [ATTRS_KEY]: { _index: 'cell_id', 'encoding-type': 'dataframe' },
      cell_id: {},
      leiden: {},
    });
    assert(sdata.tables, 'sdata.tables on mock object should be truthy');
    const table = sdata.tables.cells_table;

    expect(table.getObsIndexColumnName()).toBe('cell_id');
    expect(table.getObsColumnNames()).toEqual(['leiden']);
  });

  it('treats an obs node that is an array rather than a group as having no columns', () => {
    const sdata = createMockSpatialData({
      [ZARRAY_KEY]: { shape: [2] },
      [ATTRS_KEY]: { _index: '_index' },
      get: () => Promise.resolve({}),
    });
    assert(sdata.tables, 'sdata.tables on mock object should be truthy');
    const table = sdata.tables.cells_table;

    expect(table.getObsIndexColumnName()).toBeUndefined();
    expect(table.getObsColumnNames()).toEqual([]);
  });

  it('keeps every key when obs declares no index', () => {
    const sdata = createMockSpatialData({ leiden: {}, score: {} });
    assert(sdata.tables, 'sdata.tables on mock object should be truthy');
    const table = sdata.tables.cells_table;

    expect(table.getObsIndexColumnName()).toBeUndefined();
    expect(table.getObsColumnNames()).toEqual(['leiden', 'score']);
  });
});

describe('obs column kinds from consolidated metadata', () => {
  /**
   * The kind is readable without I/O, and without the column having been loaded —
   * which is what lets a "colour by" UI offer the right affordance before anyone
   * picks a column. Both zarr generations reach the tree, so both are covered.
   */
  const arrayNode = (metadata: Record<string, unknown>, attrs?: Record<string, unknown>) => ({
    ...(attrs ? { [ATTRS_KEY]: attrs } : {}),
    [ZARRAY_KEY]: metadata,
    get: async () => {
      throw new Error('the classifier must not touch the array');
    },
  });

  function tableWithObs(obs: Record<string, unknown>) {
    const sdata = createMockSpatialData(obs);
    assert(sdata.tables, 'sdata.tables should be truthy');
    return sdata.tables.cells_table;
  }

  it('classifies zarr v3 nodes', () => {
    const table = tableWithObs({
      UMAP1: arrayNode({ data_type: 'float64' }, { 'encoding-type': 'array' }),
      cluster: arrayNode({ data_type: 'int64' }, { 'encoding-type': 'array' }),
      is_tumour: arrayNode({ data_type: 'bool' }, { 'encoding-type': 'array' }),
      barcode: arrayNode({ data_type: 'string' }, { 'encoding-type': 'string-array' }),
      // A categorical is a GROUP of codes + categories, not an array.
      cell_type: { [ATTRS_KEY]: { 'encoding-type': 'categorical' } },
    });

    expect(
      table.getObsColumnKinds(['UMAP1', 'cluster', 'is_tumour', 'barcode', 'cell_type'])
    ).toEqual(['numeric', 'numeric', 'boolean', 'string', 'categorical']);
  });

  it('classifies zarr v2 numpy typestrings', () => {
    const table = tableWithObs({
      UMAP1: arrayNode({ dtype: '<f8' }),
      cluster: arrayNode({ dtype: '<i8' }),
      is_tumour: arrayNode({ dtype: '|b1' }),
      barcode: arrayNode({ dtype: '|O' }),
      // Older AnnData points at its levels with a `categories` attribute.
      cell_type: arrayNode({ dtype: '<i1' }, { categories: '__categories/cell_type' }),
    });

    expect(
      table.getObsColumnKinds(['UMAP1', 'cluster', 'is_tumour', 'barcode', 'cell_type'])
    ).toEqual(['numeric', 'numeric', 'boolean', 'string', 'categorical']);
  });

  it('classifies nullable columns from the encoding alone', () => {
    // A nullable column is a GROUP of `values` + `mask`, so the node carries no
    // array metadata of its own — the encoding name is the only thing on it that
    // says what the column holds. AnnData 0.13 writes string columns this way by
    // default on zarr v3, so this is the common shape, not an exotic one.
    const nullableNode = (encodingType: string, valuesDataType: string) => ({
      [ATTRS_KEY]: { 'encoding-type': encodingType, 'encoding-version': '0.1.0' },
      values: arrayNode({ data_type: valuesDataType }),
      mask: arrayNode({ data_type: 'bool' }),
    });

    const table = tableWithObs({
      barcode: nullableNode('nullable-string-array', 'string'),
      qc_count: nullableNode('nullable-integer', 'int64'),
      passes_qc: nullableNode('nullable-boolean', 'bool'),
    });

    expect(table.getObsColumnKinds(['barcode', 'qc_count', 'passes_qc'])).toEqual([
      'string',
      'numeric',
      'boolean',
    ]);
  });

  it('returns undefined for absent or unrecognised columns', () => {
    const table = tableWithObs({
      mystery: { [ATTRS_KEY]: { 'encoding-type': 'something-new' } },
    });

    expect(table.getObsColumnKinds(['mystery', 'not_there'])).toEqual([undefined, undefined]);
  });
});
