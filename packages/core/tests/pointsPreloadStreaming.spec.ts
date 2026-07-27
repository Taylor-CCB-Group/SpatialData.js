import { describe, expect, it } from 'vitest';
import { remapRowFeatureCodes } from '../src/pointsFeatures.js';
import type { PointsFeatureCatalog } from '../src/pointsTiling.js';

/**
 * The streaming preload publishes per-row codes in ITS OWN code space (each chunk's
 * dictionary order) together with the catalog describing that space. The resolver
 * then re-expresses those codes against the authoritative catalog via
 * `remapRowFeatureCodes`. These tests pin that handoff, which is what keeps a
 * point's colour matching the panel once the full scan lands.
 */

/** Preload-style catalog: dictionary (alphabetical) order. */
const PRELOAD_CATALOG: PointsFeatureCatalog = {
  featureKey: 'feature_name',
  entries: [
    { code: 0, name: 'ABCC11' },
    { code: 1, name: 'ACE2' },
    { code: 2, name: 'ACKR1' },
  ],
};

/** Full-scan catalog: row order — deliberately a different code space. */
const AUTHORITATIVE_CATALOG: PointsFeatureCatalog = {
  featureKey: 'feature_name',
  entries: [
    { code: 0, name: 'ACKR1' },
    { code: 1, name: 'ABCC11' },
    { code: 2, name: 'ACE2' },
  ],
};

describe('streaming preload code space', () => {
  it('remaps preload codes into the authoritative space by name', () => {
    // rows: ABCC11, ACE2, ACKR1, ABCC11  (preload codes)
    const preloadCodes = Int32Array.from([0, 1, 2, 0]);
    const remapped = remapRowFeatureCodes(preloadCodes, PRELOAD_CATALOG, AUTHORITATIVE_CATALOG);
    // same genes, authoritative codes
    expect(Array.from(remapped)).toEqual([1, 2, 0, 1]);
  });

  it('preserves the gene each row refers to across the remap', () => {
    const preloadCodes = Int32Array.from([0, 1, 2, 2, 1, 0]);
    const preloadName = new Map(PRELOAD_CATALOG.entries.map((e) => [e.code, e.name]));
    const authoritativeName = new Map(AUTHORITATIVE_CATALOG.entries.map((e) => [e.code, e.name]));

    const remapped = remapRowFeatureCodes(preloadCodes, PRELOAD_CATALOG, AUTHORITATIVE_CATALOG);
    for (let row = 0; row < preloadCodes.length; row += 1) {
      expect(authoritativeName.get(remapped[row])).toBe(preloadName.get(preloadCodes[row]));
    }
  });

  it('marks genes missing from the authoritative catalog as -1', () => {
    const partialAuthoritative: PointsFeatureCatalog = {
      featureKey: 'feature_name',
      entries: [{ code: 0, name: 'ACE2' }],
    };
    const remapped = remapRowFeatureCodes(
      Int32Array.from([0, 1, 2]),
      PRELOAD_CATALOG,
      partialAuthoritative
    );
    expect(Array.from(remapped)).toEqual([-1, 0, -1]);
  });

  it('is an identity pass when both catalogs already agree', () => {
    const codes = Int32Array.from([2, 0, 1, 1]);
    const remapped = remapRowFeatureCodes(codes, PRELOAD_CATALOG, PRELOAD_CATALOG);
    expect(Array.from(remapped)).toEqual(Array.from(codes));
  });
});
