import { describe, expect, it } from 'vitest';
import { featureNamesForCodes, resolveFeatureSelectionCodes } from '../src/pointsFeatures.js';
import type { PointsFeatureCatalog } from '../src/pointsTiling.js';

/**
 * Selections persist as NAMES because for a dictionary-only element the codes are
 * app-assigned — a first-seen index from whichever catalog scan ran — so the same
 * gene can be numbered differently between the resident preview and the full
 * catalog, between the two catalog paths, or between servers. A stored code can
 * therefore come back meaning a different gene, silently.
 *
 * The two catalogs below are the same three genes numbered differently, which is
 * exactly the situation the name form exists to survive.
 */
const PREVIEW: PointsFeatureCatalog = {
  featureKey: 'feature_name',
  entries: [
    { code: 0, name: 'EPCAM' },
    { code: 1, name: 'MALL' },
    { code: 2, name: 'TCIM' },
  ],
};

const FULL: PointsFeatureCatalog = {
  featureKey: 'feature_name',
  entries: [
    { code: 0, name: 'TCIM' },
    { code: 1, name: 'EPCAM' },
    { code: 2, name: 'MALL' },
  ],
};

describe('resolveFeatureSelectionCodes', () => {
  it('resolves names to whichever codes the CURRENT catalog uses', () => {
    expect(resolveFeatureSelectionCodes({ featureNames: ['EPCAM'] }, PREVIEW)).toEqual([0]);
    expect(resolveFeatureSelectionCodes({ featureNames: ['EPCAM'] }, FULL)).toEqual([1]);
  });

  it('survives a catalog renumbering — the whole point of the name form', () => {
    const names = ['EPCAM', 'TCIM'];
    // Same genes, different numbering, and the selection still means those genes.
    const asPreview = resolveFeatureSelectionCodes({ featureNames: names }, PREVIEW);
    const asFull = resolveFeatureSelectionCodes({ featureNames: names }, FULL);
    expect(featureNamesForCodes(asPreview as number[], PREVIEW)).toEqual(['EPCAM', 'TCIM']);
    expect(featureNamesForCodes(asFull as number[], FULL)).toEqual(['EPCAM', 'TCIM']);
    // …whereas the stored CODES would not have: [0, 2] is EPCAM+TCIM under the
    // preview but TCIM+MALL under the full catalog. This is the silent bug.
    expect(featureNamesForCodes([0, 2], PREVIEW)).toEqual(['EPCAM', 'TCIM']);
    expect(featureNamesForCodes([0, 2], FULL)).toEqual(['MALL', 'TCIM']);
  });

  it('round-trips a selection through names and back', () => {
    const codes = [1, 2];
    const names = featureNamesForCodes(codes, FULL);
    expect(names).toEqual(['EPCAM', 'MALL']);
    expect(resolveFeatureSelectionCodes({ featureNames: names }, FULL)).toEqual(codes);
  });

  it('treats absent names as "no filter" and falls back to legacy codes', () => {
    expect(resolveFeatureSelectionCodes({}, FULL)).toBeUndefined();
    expect(resolveFeatureSelectionCodes({ featureCodes: [2] }, FULL)).toEqual([2]);
  });

  it('lets names win over a stale legacy code list', () => {
    expect(
      resolveFeatureSelectionCodes({ featureNames: ['TCIM'], featureCodes: [99] }, FULL)
    ).toEqual([0]);
  });

  it('drops names this element does not have, rather than inventing codes', () => {
    // A config may name genes from another dataset; those must not become -1 or 0.
    expect(resolveFeatureSelectionCodes({ featureNames: ['EPCAM', 'NOT_HERE'] }, FULL)).toEqual([
      1,
    ]);
    expect(resolveFeatureSelectionCodes({ featureNames: ['NOT_HERE'] }, FULL)).toEqual([]);
  });

  it('selects nothing — not everything — while the catalog is still loading', () => {
    // Resolving to `undefined` here would read as "no filter" and flash the whole
    // dataset before the catalog settles. Empty draws nothing and self-corrects.
    expect(resolveFeatureSelectionCodes({ featureNames: ['EPCAM'] }, undefined)).toEqual([]);
    expect(resolveFeatureSelectionCodes({ featureNames: ['EPCAM'] }, null)).toEqual([]);
    // But an absent selection is still "everything", catalog or no catalog.
    expect(resolveFeatureSelectionCodes({}, undefined)).toBeUndefined();
  });

  it('keeps an explicit empty selection empty', () => {
    expect(resolveFeatureSelectionCodes({ featureNames: [] }, FULL)).toEqual([]);
  });
});
