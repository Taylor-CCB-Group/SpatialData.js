import { Dictionary, Int16, tableFromArrays, Utf8, vectorFromArray } from 'apache-arrow';
import { describe, expect, it } from 'vitest';
import { tallyFeatureCodesFromColumn } from '../src/models/VPointsSource.js';
import { MORTON_CODE_2D_COLUMN, MORTON_CODE_EXTREME_VALUE_INDICATOR } from '../src/pointsTiling.js';

/**
 * A morton-tiled element carries up to four SENTINEL rows at the head of its first
 * row group — they encode the dataset bounding box, not real points. Every catalog
 * builder is told to skip them; the tally that fills in the same catalog's counts
 * was not, so counts and entries could disagree about the very same catalog.
 *
 * Small in magnitude (at most four rows) but not cosmetic: it is a count of points
 * that are not points, in the one number the feature panel presents as authoritative.
 */

const FEATURE_KEY = 'feature_name';
const nameToCode = new Map([
  ['GENE_A', 0],
  ['GENE_B', 1],
]);

/** Two sentinel rows, then four real ones. */
const NAMES = ['GENE_A', 'GENE_A', 'GENE_A', 'GENE_B', 'GENE_A', 'GENE_B'];
const MORTON = [
  MORTON_CODE_EXTREME_VALUE_INDICATOR,
  MORTON_CODE_EXTREME_VALUE_INDICATOR,
  17,
  18,
  19,
  20,
];

function columns(dictionaryEncoded: boolean) {
  const table = tableFromArrays({
    [FEATURE_KEY]: dictionaryEncoded
      ? (vectorFromArray(NAMES, new Dictionary(new Utf8(), new Int16())) as never)
      : (NAMES as never),
    [MORTON_CODE_2D_COLUMN]: Int32Array.from(MORTON) as never,
  });
  return {
    name: table.getChild(FEATURE_KEY) as never,
    morton: table.getChild(MORTON_CODE_2D_COLUMN) as never,
    rows: table.numRows,
  };
}

function tally(dictionaryEncoded: boolean, withMorton: boolean) {
  const { name, morton, rows } = columns(dictionaryEncoded);
  const counts = new Map<number, number>();
  tallyFeatureCodesFromColumn(name, rows, nameToCode, counts, withMorton ? morton : null);
  return counts;
}

describe('feature count tally — morton sentinels', () => {
  // Both branches matter: the dictionary fast path is the one a real Xenium
  // `transcripts` takes, and it indexes the chunk directly rather than via `get`.
  it.each([
    ['dictionary-encoded', true],
    ['plain utf8', false],
  ])('excludes sentinel rows from the counts (%s)', (_label, dictionaryEncoded) => {
    const counts = tally(dictionaryEncoded, true);
    // 4 real rows: GENE_A ×2, GENE_B ×2. The two sentinels also say GENE_A.
    expect(counts.get(0)).toBe(2);
    expect(counts.get(1)).toBe(2);
    expect([...counts.values()].reduce((sum, n) => sum + n, 0)).toBe(4);
  });

  it('counts every row when the element is not tiled', () => {
    // No morton column → nothing to skip, and the head rows are ordinary points.
    const counts = tally(true, false);
    expect(counts.get(0)).toBe(4);
    expect(counts.get(1)).toBe(2);
  });
});
