import { tableFromArrays, tableToIPC } from 'apache-arrow';
import { describe, expect, it } from 'vitest';
import {
  decodeParquetRowGroupsToTable,
  extractRowFeatureCodesFromTable,
} from '../src/workers/pointsWorkerScan.js';

function mockReadParquetRowGroup(
  chunks: Array<Array<{ name: string; code: number }>>
): (
  schemaBytes: Uint8Array,
  rowGroupBytes: Uint8Array,
  rowGroupIndex: number,
  options?: { columns?: string[] }
) => { intoIPCStream(): Uint8Array } {
  return (_schemaBytes, _rowGroupBytes, rowGroupIndex) => {
    const rows = chunks[rowGroupIndex] ?? [];
    const table = tableFromArrays({
      feature_name: rows.map((row) => row.name),
      feature_name_codes: Int32Array.from(rows.map((row) => row.code)),
    });
    return { intoIPCStream: () => tableToIPC(table) };
  };
}

describe('decodeParquetRowGroupsToTable', () => {
  it('merges row groups and respects maxRows', async () => {
    const table = await decodeParquetRowGroupsToTable(
      mockReadParquetRowGroup([
        [
          { name: 'a', code: 0 },
          { name: 'b', code: 1 },
        ],
        [
          { name: 'c', code: 2 },
          { name: 'd', code: 3 },
        ],
      ]),
      [
        { schemaBytes: new Uint8Array(0), rowGroupBytes: new Uint8Array(0), rowGroupIndex: 0 },
        { schemaBytes: new Uint8Array(0), rowGroupBytes: new Uint8Array(0), rowGroupIndex: 1 },
      ],
      ['feature_name', 'feature_name_codes'],
      3
    );
    expect(table.numRows).toBe(3);
  });
});

describe('extractRowFeatureCodesFromTable with featureCodeByName', () => {
  it('maps dictionary feature names to catalog codes', () => {
    const names = ['gene_a', 'gene_b', 'gene_a'];
    const table = tableFromArrays({
      feature_name: names,
    });
    const featureCodeByName = new Map([
      ['gene_a', 0],
      ['gene_b', 1],
    ]);
    const codes = extractRowFeatureCodesFromTable(
      table,
      'feature_name',
      undefined,
      featureCodeByName
    );
    expect([...codes]).toEqual([0, 1, 0]);
  });
});
