import { Dictionary, Int16, tableFromArrays, Utf8, Vector, vectorFromArray } from 'apache-arrow';
import { describe, expect, it } from 'vitest';
import { resolveRowFeatureCodesFromTable } from '../src/pointsFeatures.js';

const FEATURE_KEY = 'feature_name';

function dictionaryTable(names: string[]) {
  return tableFromArrays({
    [FEATURE_KEY]: vectorFromArray(names, new Dictionary(new Utf8(), new Int16())),
  });
}

/** Reference implementation: the per-row form this used to use. */
function expectedCodes(names: (string | null)[], codeByName: Map<string, number>) {
  return names.map((name) => (name == null ? -1 : (codeByName.get(name) ?? -1)));
}

describe('resolveRowFeatureCodesFromTable', () => {
  it('maps a dictionary column through its dictionary', () => {
    const names = ['GENE_A', 'GENE_B', 'GENE_A', 'GENE_C', 'GENE_B'];
    const codeByName = new Map([
      ['GENE_A', 0],
      ['GENE_B', 1],
      ['GENE_C', 2],
    ]);
    const codes = resolveRowFeatureCodesFromTable(
      dictionaryTable(names),
      FEATURE_KEY,
      undefined,
      codeByName
    );
    expect(Array.from(codes as Int32Array)).toEqual(expectedCodes(names, codeByName));
  });

  it('gives -1 to names absent from the map', () => {
    const names = ['GENE_A', 'MISSING', 'GENE_B'];
    const codeByName = new Map([
      ['GENE_A', 7],
      ['GENE_B', 9],
    ]);
    const codes = resolveRowFeatureCodesFromTable(
      dictionaryTable(names),
      FEATURE_KEY,
      undefined,
      codeByName
    );
    expect(Array.from(codes as Int32Array)).toEqual([7, -1, 9]);
  });

  it('handles nulls in a dictionary column', () => {
    const names = ['GENE_A', null, 'GENE_B'];
    const codeByName = new Map([
      ['GENE_A', 0],
      ['GENE_B', 1],
    ]);
    const codes = resolveRowFeatureCodesFromTable(
      // biome-ignore lint/suspicious/noExplicitAny: mixed null/string literal for the fixture
      dictionaryTable(names as any),
      FEATURE_KEY,
      undefined,
      codeByName
    );
    expect(Array.from(codes as Int32Array)).toEqual([0, -1, 1]);
  });

  it('handles a plain (non-dictionary) utf8 column', () => {
    const names = ['GENE_A', 'GENE_B', 'GENE_A'];
    const codeByName = new Map([
      ['GENE_A', 3],
      ['GENE_B', 4],
    ]);
    const table = tableFromArrays({ [FEATURE_KEY]: names });
    const codes = resolveRowFeatureCodesFromTable(table, FEATURE_KEY, undefined, codeByName);
    expect(Array.from(codes as Int32Array)).toEqual([3, 4, 3]);
  });

  it('prefers an explicit feature-code column when present', () => {
    const table = tableFromArrays({
      [FEATURE_KEY]: ['GENE_A', 'GENE_B'],
      feature_name_codes: Int32Array.from([11, 22]),
    });
    const codes = resolveRowFeatureCodesFromTable(
      table,
      FEATURE_KEY,
      'feature_name_codes',
      new Map()
    );
    expect(Array.from(codes as ArrayLike<number>)).toEqual([11, 22]);
  });

  it('resolves each chunk against its OWN dictionary', () => {
    // Parquet gives every column chunk its own dictionary, so index 0 in one
    // chunk need not be the same gene as index 0 in the next — a real 4M-row
    // transcripts column arrives as thousands of such chunks. Reading only the
    // first chunk's dictionary (as the old helper did) mislabels later rows.
    const chunkA = vectorFromArray(
      ['GENE_A', 'GENE_B'],
      new Dictionary(new Utf8(), new Int16(), 0)
    );
    const chunkB = vectorFromArray(
      ['GENE_C', 'GENE_D'],
      new Dictionary(new Utf8(), new Int16(), 1)
    );
    const column = new Vector([...chunkA.data, ...chunkB.data]);
    expect(column.data.length).toBe(2);

    const codeByName = new Map([
      ['GENE_A', 0],
      ['GENE_B', 1],
      ['GENE_C', 2],
      ['GENE_D', 3],
    ]);
    const table = {
      numRows: 4,
      getChild: (name: string) => (name === FEATURE_KEY ? column : null),
    } as unknown as Parameters<typeof resolveRowFeatureCodesFromTable>[0];
    const codes = resolveRowFeatureCodesFromTable(table, FEATURE_KEY, undefined, codeByName);
    expect(Array.from(codes as Int32Array)).toEqual([0, 1, 2, 3]);
  });
});
