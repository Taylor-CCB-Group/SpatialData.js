import { describe, expect, it } from 'vitest';
import {
  buildFeaturePalette,
  FEATURE_PALETTE_WIDTH,
  featureCodeToCssColor,
  featureCodeToRgb,
  featurePaletteRows,
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
    // One full row is a floor, not the requested size — see featurePaletteRows.
    expect([palette.width, palette.height]).toEqual([FEATURE_PALETTE_WIDTH, 1]);
    expect(palette.data.length).toBe(FEATURE_PALETTE_WIDTH * 4);
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

  it('covers a default code space even with NO catalog, so colour works before one loads', () => {
    // The regression this pins: sizing the LUT from the catalog made it 1 texel wide
    // until the catalog landed, and the shader clamps every code to texel 0 — the
    // whole layer one flat colour for the entire load of a big element.
    const palette = buildFeaturePalette(0);
    expect([palette.width, palette.height]).toEqual([FEATURE_PALETTE_WIDTH, 1]);

    // Distinct codes must get distinct texels with no catalog at all.
    const texel = (code: number) => [...palette.data.slice(code * 4, code * 4 + 3)];
    expect(texel(7)).toEqual([...featureCodeToRgb(7)]);
    expect(texel(500)).not.toEqual(texel(7));
  });

  it('adds rows, not width, for a code space past the GPU texture limit', () => {
    // A whole-transcriptome panel: one row this wide exceeds the common 16,384
    // MAX_TEXTURE_SIZE, so texture creation failed and every point drew uncoloured.
    const palette = buildFeaturePalette(24_674);
    expect(palette.width).toBeLessThanOrEqual(4096);
    expect(palette.height).toBeLessThanOrEqual(4096);
    expect(palette.width * palette.height).toBeGreaterThanOrEqual(24_674);

    // The shader reads texel (code % width, code / width) of the row-major data.
    const code = 20_000;
    const x = code % palette.width;
    const y = Math.floor(code / palette.width);
    const o = (y * palette.width + x) * 4;
    expect([...palette.data.slice(o, o + 4)]).toEqual([...featureCodeToRgb(code), 255]);

    // …and never shrinks below one row for a small/unknown space.
    expect(featurePaletteRows(12)).toBe(1);
    expect(featurePaletteRows(Number.NaN)).toBe(1);
  });
});
