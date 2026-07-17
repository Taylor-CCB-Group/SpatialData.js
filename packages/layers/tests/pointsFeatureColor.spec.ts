import { describe, expect, it } from 'vitest';
import {
  buildFeaturePalette,
  featureCodeToCssColor,
  featureCodeToRgb,
} from '../src/pointsFeatureColor.js';

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

describe('buildFeaturePalette', () => {
  it('lays out one RGBA texel per code, defaulting to featureCodeToRgb', () => {
    const palette = buildFeaturePalette(3);
    expect(palette.width).toBe(3);
    expect(palette.data.length).toBe(3 * 4);
    for (let code = 0; code < 3; code += 1) {
      const [r, g, b] = featureCodeToRgb(code);
      const o = code * 4;
      // The LUT must match the procedural colour byte-for-byte (look-preserving swap).
      expect([
        palette.data[o],
        palette.data[o + 1],
        palette.data[o + 2],
        palette.data[o + 3],
      ]).toEqual([r, g, b, 255]);
    }
  });

  it('patches only the overridden codes, leaving the rest at their default', () => {
    const palette = buildFeaturePalette(4, new Map([[2, [10, 20, 30] as const]]));
    expect([palette.data[8], palette.data[9], palette.data[10], palette.data[11]]).toEqual([
      10, 20, 30, 255,
    ]);
    const [r, g, b] = featureCodeToRgb(1);
    expect([palette.data[4], palette.data[5], palette.data[6]]).toEqual([r, g, b]);
  });

  it('never produces a zero-width table (a 1×1 fallback keeps the sampler bindable)', () => {
    expect(buildFeaturePalette(0).width).toBe(1);
    expect(buildFeaturePalette(0).data.length).toBe(4);
  });
});
