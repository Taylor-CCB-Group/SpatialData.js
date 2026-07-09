import { describe, expect, it } from 'vitest';

import {
  describeFeatureRowState,
  type FeatureRowStateInput,
} from '../src/SpatialCanvas/PointsFeatureFilterPanel';

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
