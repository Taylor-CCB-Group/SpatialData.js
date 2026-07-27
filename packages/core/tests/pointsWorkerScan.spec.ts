import { tableFromArrays, tableToIPC } from 'apache-arrow';
import { describe, expect, it } from 'vitest';
import {
  decodeGeometryWithFeaturesFromPayload,
  decodeParquetRowGroupsToTable,
  extractGeometryColumnar,
  extractRowFeatureCodesFromTable,
  scanFeatureCatalogFromPayload,
  scanTableByFeatureCodes,
} from '../src/workers/pointsWorkerScan.js';

const throwingReadParquet = (() => {
  throw new Error('readParquet should not be called on the rowGroup path');
}) as unknown as (
  bytes: Uint8Array,
  options?: { columns?: string[] }
) => {
  intoIPCStream(): Uint8Array;
};

function singleRowGroup(columns: Record<string, unknown>) {
  const table = tableFromArrays(columns as never);
  const read = () => ({ intoIPCStream: () => tableToIPC(table) });
  return {
    read,
    rowGroups: [
      { schemaBytes: new Uint8Array(0), rowGroupBytes: new Uint8Array(0), rowGroupIndex: 0 },
    ],
  };
}

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

describe('decodeGeometryWithFeaturesFromPayload', () => {
  it('derives geometry, row codes, and catalog from one projected decode', async () => {
    const { read, rowGroups } = singleRowGroup({
      x: Float32Array.from([0, 1, 2]),
      y: Float32Array.from([0, 1, 2]),
      feature_name: ['gene_a', 'gene_b', 'gene_a'],
      feature_name_codes: Int32Array.from([0, 1, 0]),
    });
    const result = await decodeGeometryWithFeaturesFromPayload(throwingReadParquet, read, {
      rowGroups,
      axisNames: ['x', 'y'],
      columns: ['x', 'y', 'feature_name', 'feature_name_codes'],
      featureKey: 'feature_name',
      featureCodeColumnName: 'feature_name_codes',
    });

    expect(result.shape).toEqual([2, 3]);
    expect(Array.from(result.data[0])).toEqual([0, 1, 2]);
    expect(result.featureCodes && Array.from(result.featureCodes)).toEqual([0, 1, 0]);
    expect(result.featureCatalog).toEqual({
      featureKey: 'feature_name',
      entries: [
        { code: 0, name: 'gene_a' },
        { code: 1, name: 'gene_b' },
      ],
    });
  });

  it('assigns codes by first-seen order for dict-only columns (no code column)', async () => {
    const { read, rowGroups } = singleRowGroup({
      x: Float32Array.from([0, 1, 2]),
      y: Float32Array.from([3, 4, 5]),
      feature_name: ['B', 'A', 'B'],
    });
    const result = await decodeGeometryWithFeaturesFromPayload(throwingReadParquet, read, {
      rowGroups,
      axisNames: ['x', 'y'],
      columns: ['x', 'y', 'feature_name'],
      featureKey: 'feature_name',
    });

    expect(result.featureCodes && Array.from(result.featureCodes)).toEqual([0, 1, 0]);
    expect(result.featureCatalog?.entries).toEqual([
      { code: 0, name: 'B' },
      { code: 1, name: 'A' },
    ]);
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

describe('scanTableByFeatureCodes with featureCodeByName (dict-only)', () => {
  it('matches rows by feature_name against the catalog map and retains authoritative codes', () => {
    // Dict-only: no code column. Rows for gene_c (code 2) live among others; the
    // scan must resolve names via the map and keep only the selected code's rows.
    const table = tableFromArrays({
      x: Float32Array.from([10, 11, 12, 13]),
      y: Float32Array.from([20, 21, 22, 23]),
      feature_name: ['gene_a', 'gene_c', 'gene_b', 'gene_c'],
    });
    const featureCodeByName = new Map([
      ['gene_a', 0],
      ['gene_b', 1],
      ['gene_c', 2],
    ]);
    const xs: number[] = [];
    const ys: number[] = [];
    const codes: number[] = [];
    const matched = scanTableByFeatureCodes({
      table,
      axisNames: ['x', 'y'],
      featureKey: 'feature_name',
      featureCodeColumnName: undefined,
      featureCodes: [2],
      memoryCap: 1_000,
      matchedRows: 0,
      xs,
      ys,
      zs: [],
      codes,
      featureCodeByName,
    });
    expect(matched).toBe(2);
    expect(xs).toEqual([11, 13]); // the two gene_c rows
    expect(ys).toEqual([21, 23]);
    expect(codes).toEqual([2, 2]); // authoritative codes retained
  });

  it('matches nothing when no name→code map is supplied for dict-only data', () => {
    const table = tableFromArrays({
      x: Float32Array.from([10, 11]),
      y: Float32Array.from([20, 21]),
      feature_name: ['gene_a', 'gene_c'],
    });
    const xs: number[] = [];
    const matched = scanTableByFeatureCodes({
      table,
      axisNames: ['x', 'y'],
      featureKey: 'feature_name',
      featureCodeColumnName: undefined,
      featureCodes: [2],
      memoryCap: 1_000,
      matchedRows: 0,
      xs,
      ys: [],
      zs: [],
    });
    expect(matched).toBe(0);
    expect(xs).toEqual([]);
  });
});

describe('extractGeometryColumnar', () => {
  it('returns float32 axis columns', () => {
    const table = tableFromArrays({
      x: [0, 1],
      y: [2, 3],
    });
    const geometry = extractGeometryColumnar(table, ['x', 'y']);
    expect(geometry.shape).toEqual([2, 2]);
    expect([...geometry.xs]).toEqual([0, 1]);
    expect([...geometry.ys]).toEqual([2, 3]);
  });
});

function mockReadParquet(
  rows: Array<{ name: string; code: number }>
): (bytes: Uint8Array, options?: { columns?: string[] }) => { intoIPCStream(): Uint8Array } {
  return () => {
    const table = tableFromArrays({
      feature_name: rows.map((row) => row.name),
      feature_name_codes: Int32Array.from(rows.map((row) => row.code)),
    });
    return { intoIPCStream: () => tableToIPC(table) };
  };
}

describe('scanFeatureCatalogFromPayload', () => {
  it('accumulates catalog entries from row groups', async () => {
    const catalog = await scanFeatureCatalogFromPayload(
      mockReadParquet([]),
      mockReadParquetRowGroup([
        [
          { name: 'gene_a', code: 0 },
          { name: 'gene_b', code: 1 },
        ],
      ]),
      {
        rowGroups: [
          { schemaBytes: new Uint8Array(0), rowGroupBytes: new Uint8Array(0), rowGroupIndex: 0 },
        ],
        parts: [new Uint8Array(0)],
        columns: ['feature_name', 'feature_name_codes'],
        featureKey: 'feature_name',
        featureCodeColumnName: 'feature_name_codes',
      }
    );
    expect(catalog?.entries).toEqual([
      { code: 0, name: 'gene_a' },
      { code: 1, name: 'gene_b' },
    ]);
  });
});

/**
 * The scan reads coordinates by row index. `Vector.get(i)` makes that look like an
 * array read, but on a MULTI-CHUNK vector — any table assembled from more than one
 * record batch, which is the normal case for a multi-row-group or multi-part read —
 * Arrow swaps in a `binarySearch` over chunk offsets per call. The scan now hoists
 * each column into one flat typed array instead.
 *
 * These pin the thing that rewrite could plausibly break: chunk-boundary indexing.
 * A row must resolve to the same coordinate whether the table arrived as one chunk
 * or several, and matches must still be found in the later chunks.
 */
describe('scanTableByFeatureCodes over a multi-chunk table', () => {
  const scan = (table: Parameters<typeof scanTableByFeatureCodes>[0]['table']) => {
    const xs: number[] = [];
    const ys: number[] = [];
    const codes: number[] = [];
    const matched = scanTableByFeatureCodes({
      table,
      axisNames: ['x', 'y'],
      featureKey: 'feature_name',
      featureCodeColumnName: 'feature_name_codes',
      featureCodes: [1],
      memoryCap: 1_000,
      matchedRows: 0,
      xs,
      ys,
      zs: [],
      codes,
    });
    return { matched, xs, ys, codes };
  };

  const rows = (start: number, count: number) => ({
    x: Float32Array.from({ length: count }, (_v, i) => start + i),
    y: Float32Array.from({ length: count }, (_v, i) => 100 + start + i),
    // Alternating codes, so every chunk holds both matches and non-matches.
    feature_name: Array.from({ length: count }, (_v, i) => `gene_${(start + i) % 2}`),
    feature_name_codes: Int32Array.from({ length: count }, (_v, i) => (start + i) % 2),
  });

  it('reads the same rows from a chunked table as from a contiguous one', () => {
    const whole = tableFromArrays(rows(0, 40) as never);
    // One record batch per source table — the shape a multi-row-group or
    // multi-part read produces, and what makes the columns multi-chunk.
    const chunked = tableFromArrays(rows(0, 20) as never).concat(
      tableFromArrays(rows(20, 20) as never)
    );
    expect(chunked.numRows).toBe(40);
    // Guard the premise: if this were single-chunk the test would prove nothing.
    expect(chunked.getChild('x')?.data.length).toBeGreaterThan(1);

    const fromWhole = scan(whole);
    const fromChunked = scan(chunked);

    expect(fromChunked.matched).toBe(fromWhole.matched);
    expect(fromChunked.xs).toEqual(fromWhole.xs);
    expect(fromChunked.ys).toEqual(fromWhole.ys);
    expect(fromChunked.codes).toEqual(fromWhole.codes);
    // And the values are actually right, not merely equal to each other: odd x.
    expect(fromChunked.xs).toEqual(Array.from({ length: 20 }, (_v, i) => i * 2 + 1));
    // Matches from the SECOND chunk are present — the chunk-offset bug would drop
    // or misread these.
    expect(fromChunked.xs.at(-1)).toBe(39);
    expect(fromChunked.ys.at(-1)).toBe(139);
  });
});
