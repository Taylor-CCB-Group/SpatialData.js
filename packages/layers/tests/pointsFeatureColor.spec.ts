import { describe, expect, it } from 'vitest';
import { featureCodeToRgb, featureCodeToCssColor } from '../src/pointsFeatureColor.js';

describe('featureCodeToRgb', () => {
  it('returns grey for the negative "no colour" sentinel', () => {
    expect(featureCodeToRgb(-1)).toEqual([128, 128, 128]);
  });

  it('is deterministic and in range for a code', () => {
    const rgb = featureCodeToRgb(231);
    expect(rgb).toEqual(featureCodeToRgb(231));
    for (const channel of rgb) {
      expect(channel).toBeGreaterThanOrEqual(0);
      expect(channel).toBeLessThanOrEqual(255);
    }
  });

  it('gives distinct colours to adjacent codes (golden-angle spread)', () => {
    expect(featureCodeToRgb(10)).not.toEqual(featureCodeToRgb(11));
  });

  it('formats a CSS rgb() string', () => {
    const [r, g, b] = featureCodeToRgb(42);
    expect(featureCodeToCssColor(42)).toBe(`rgb(${r}, ${g}, ${b})`);
  });
});
