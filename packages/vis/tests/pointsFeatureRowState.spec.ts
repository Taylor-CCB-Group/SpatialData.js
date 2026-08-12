import { describe, expect, it } from 'vitest';

import {
  describeFeatureRowState,
  type FeatureRowStateInput,
} from '../src/SpatialCanvas/featureRowState';

const base: FeatureRowStateInput = {
  resident: false,
  rendered: false,
  selected: false,
  scanning: false,
  supportsOnDemandLoad: true,
  residentKnown: true,
};

describe('describeFeatureRowState', () => {
  it('resident features are never greyed', () => {
    const s = describeFeatureRowState({ ...base, resident: true });
    expect(s).toMatchObject({ tone: 'resident', greyed: false });
  });

  it('a rendered + selected feature is loaded (on screen)', () => {
    const s = describeFeatureRowState({ ...base, rendered: true, selected: true });
    expect(s).toMatchObject({ tone: 'loaded', greyed: false });
  });

  it('a rendered but deselected feature is cached (in memory, not dropped)', () => {
    // The removal fast path: still in the matched batch, just hidden. NOT greyed —
    // re-adding it is instant, which is the whole point of subset reuse.
    const s = describeFeatureRowState({ ...base, rendered: true, selected: false });
    expect(s).toMatchObject({ tone: 'cached', greyed: false });
    expect(s.reason).toMatch(/re-adding it is instant/);
  });

  it('a selected feature whose scan is running is loading (greyed, distinct tone)', () => {
    const s = describeFeatureRowState({ ...base, selected: true, scanning: true });
    expect(s).toMatchObject({ tone: 'loading', greyed: true });
  });

  it('a non-resident, non-loaded feature on an indexed element is "not loaded"', () => {
    const s = describeFeatureRowState({ ...base, supportsOnDemandLoad: true });
    expect(s).toMatchObject({ tone: 'notLoaded', greyed: true });
    expect(s.reason).toMatch(/select it to fetch/);
  });

  it('a non-resident feature on a dict-only element is "not in sample" (no on-demand)', () => {
    const s = describeFeatureRowState({ ...base, supportsOnDemandLoad: false });
    expect(s).toMatchObject({ tone: 'noIndex', greyed: true });
    expect(s.reason).toMatch(/no feature index/);
  });

  it('treats everything as shown when the resident set is unknown', () => {
    const s = describeFeatureRowState({ ...base, residentKnown: false });
    expect(s.greyed).toBe(false);
  });

  it('resident wins over an in-flight scan', () => {
    const s = describeFeatureRowState({ ...base, resident: true, selected: true, scanning: true });
    expect(s.tone).toBe('resident');
  });
});

describe('describeFeatureRowState — partial residency', () => {
  // `resident` only means "at least one point made the memory cap". On a truncated
  // element that is true of nearly every feature, so a row that reports only
  // residency presents a sample as the whole feature.
  const partial = (over: Partial<FeatureRowStateInput> = {}) =>
    describeFeatureRowState({
      ...base,
      resident: true,
      residentPointCount: 400_000,
      datasetPointCount: 1_182_402,
      ...over,
    });

  it('marks a resident-but-incomplete feature partial, and still draws it', () => {
    expect(partial()).toMatchObject({ tone: 'partial', greyed: false, label: 'partial' });
  });

  it('quotes both counts and the share in the reason', () => {
    const reason = partial().reason;
    expect(reason).toContain('400,000');
    expect(reason).toContain('1,182,402');
    expect(reason).toContain('34%');
  });

  it('stays plainly resident when the whole feature is inside the cap', () => {
    expect(partial({ residentPointCount: 1_182_402 })).toMatchObject({ tone: 'resident' });
  });

  it('does not claim partial once a scan has supplied the feature whole', () => {
    // The resident shortfall is real but irrelevant: the matched batch is what draws.
    // `resident` still outranks `rendered` (unchanged precedence) — what matters is
    // that the row does not announce a shortfall that is no longer on screen.
    const state = partial({ rendered: true, selected: true });
    expect(state.tone).not.toBe('partial');
    expect(state.greyed).toBe(false);
  });

  it('falls back to the blunter classification while counts are unknown', () => {
    expect(partial({ residentPointCount: undefined })).toMatchObject({ tone: 'resident' });
    expect(partial({ datasetPointCount: undefined })).toMatchObject({ tone: 'resident' });
  });

  it('never rounds a sliver to 0% or an almost-complete feature to 100%', () => {
    // Both would state the opposite of the truth: "0%" for a feature that IS drawing
    // points, "100%" for one that is missing some.
    expect(partial({ residentPointCount: 3, datasetPointCount: 1_000_000 }).reason).toContain(
      '<1%'
    );
    expect(partial({ residentPointCount: 999_999, datasetPointCount: 1_000_000 }).reason).toContain(
      '>99%'
    );
  });
});
