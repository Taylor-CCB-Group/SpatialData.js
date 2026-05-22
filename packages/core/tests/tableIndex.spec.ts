import { describe, expect, it } from 'vitest';
import { tableToIndexColumnName } from '../src/models/VTableSource.js';

function tableWithPandasIndex(indexColumns: unknown[]) {
  return {
    schema: {
      metadata: new Map([
        [
          'pandas',
          JSON.stringify({
            index_columns: indexColumns,
          }),
        ],
      ]),
    },
  } as Parameters<typeof tableToIndexColumnName>[0];
}

describe('tableToIndexColumnName', () => {
  it('returns a string column name when the index is materialized', () => {
    expect(tableToIndexColumnName(tableWithPandasIndex(['cell_id']))).toBe('cell_id');
  });

  it('returns undefined for GeoPandas RangeIndex metadata (xenium_landmarks)', () => {
    expect(
      tableToIndexColumnName(
        tableWithPandasIndex([{ kind: 'range', name: null, start: 0, stop: 3, step: 1 }])
      )
    ).toBeUndefined();
  });
});
