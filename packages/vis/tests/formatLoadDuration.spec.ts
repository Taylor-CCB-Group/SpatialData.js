import { describe, expect, it } from 'vitest';

import { formatLoadDurationMs } from '../src/SpatialCanvas/useLayerData.js';

describe('formatLoadDurationMs', () => {
  it('formats sub-second durations in milliseconds', () => {
    expect(formatLoadDurationMs(850)).toBe('850 ms');
  });

  it('formats seconds with one decimal place', () => {
    expect(formatLoadDurationMs(1234)).toBe('1.2 s');
  });

  it('formats long durations as whole seconds', () => {
    expect(formatLoadDurationMs(12_500)).toBe('13 s');
  });
});
