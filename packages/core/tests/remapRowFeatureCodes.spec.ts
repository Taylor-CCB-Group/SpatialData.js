import { describe, expect, it } from 'vitest';

import { remapRowFeatureCodes } from '../src/pointsFeatures.js';
import type { PointsFeatureCatalog } from '../src/pointsTiling.js';

const catalog = (pairs: Array<[number, string]>): PointsFeatureCatalog => ({
  featureKey: 'feature_name',
  entries: pairs.map(([code, name]) => ({ code, name })),
});

describe('remapRowFeatureCodes', () => {
  it('translates codes across catalogs that assigned different codes to the same name', () => {
    // Dictionary-only datasets assign codes by first-seen order, so the resident
    // preview and the full-dataset scan can disagree. The resident batch here saw
    // GeneB first (code 0), GeneA second (code 1); the full catalog is the reverse.
    const resident = catalog([
      [0, 'GeneB'],
      [1, 'GeneA'],
    ]);
    const full = catalog([
      [0, 'GeneA'],
      [1, 'GeneB'],
    ]);
    // Rows: GeneB, GeneA, GeneB in resident codes.
    const remapped = remapRowFeatureCodes(new Int32Array([0, 1, 0]), resident, full);
    // Same genes, now in the full catalog's space: GeneB→1, GeneA→0.
    expect(Array.from(remapped)).toEqual([1, 0, 1]);
  });

  it('is an identity pass when both catalogs agree (e.g. a real code column)', () => {
    const shared = catalog([
      [0, 'GeneA'],
      [1, 'GeneB'],
    ]);
    const remapped = remapRowFeatureCodes(new Int32Array([1, 0, 1]), shared, shared);
    expect(Array.from(remapped)).toEqual([1, 0, 1]);
  });

  it('maps codes with no name in the source, or names absent from the target, to -1', () => {
    const resident = catalog([
      [0, 'GeneA'],
      [1, 'GeneB'],
    ]);
    // Target lacks GeneB entirely (and gained an unrelated gene).
    const partial = catalog([
      [0, 'GeneA'],
      [5, 'GeneC'],
    ]);
    // Row codes include an unknown source code (7) and GeneB (1, absent downstream).
    const remapped = remapRowFeatureCodes(new Int32Array([0, 1, 7]), resident, partial);
    expect(Array.from(remapped)).toEqual([0, -1, -1]);
  });

  it('returns an Int32Array of the same length', () => {
    const c = catalog([[0, 'GeneA']]);
    const remapped = remapRowFeatureCodes(new Int32Array([0, 0, 0, 0]), c, c);
    expect(remapped).toBeInstanceOf(Int32Array);
    expect(remapped).toHaveLength(4);
  });
});
