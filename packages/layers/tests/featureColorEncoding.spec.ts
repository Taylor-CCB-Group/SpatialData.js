import { describe, expect, it } from 'vitest';
import {
  assignFeatureColors,
  featureColorAt,
  resolveFeatureFillColorMode,
} from '../src/featureColorEncoding';

const RED: [number, number, number, number] = [255, 0, 0, 255];
const GREY: [number, number, number, number] = [128, 128, 128, 255];

describe('auto mode with a declared column kind', () => {
  /**
   * The kind is what the STORE says the column is. It is not recoverable from the
   * decoded values, which is why both of these were bugs before it was plumbed
   * through: a float column with one NaN read as non-numeric, and integer cluster
   * codes read as a continuum.
   */
  it('trusts numeric over values that would sniff as categorical', () => {
    expect(resolveFeatureFillColorMode('auto', ['1', 'NaN', '3'], 'numeric')).toBe('continuous');
  });

  it('trusts categorical over values that would sniff as numeric', () => {
    // Cluster ids 0..3: every value parses, so sniffing says continuous. The store
    // says these are levels, and the store is right.
    expect(resolveFeatureFillColorMode('auto', ['0', '1', '2', '3'], 'categorical')).toBe(
      'categorical'
    );
  });

  it('treats boolean as two levels, not a 0..1 ramp', () => {
    expect(resolveFeatureFillColorMode('auto', ['true', 'false'], 'boolean')).toBe('categorical');
  });

  it('falls back to sniffing when no kind is available', () => {
    expect(resolveFeatureFillColorMode('auto', ['1', '2'])).toBe('continuous');
    expect(resolveFeatureFillColorMode('auto', ['1', 'tumour'])).toBe('categorical');
  });

  it('never overrides an explicit mode', () => {
    expect(resolveFeatureFillColorMode('categorical', ['1', '2'], 'numeric')).toBe('categorical');
    expect(resolveFeatureFillColorMode('continuous', ['a', 'b'], 'categorical')).toBe('continuous');
  });
});

describe('missing-value policy', () => {
  it('leaves missing features uncoloured by default', () => {
    const colors = assignFeatureColors({
      values: ['tumour', '', 'stroma'],
      mode: 'categorical',
      alpha: 255,
    });
    expect(colors[1]).toBeUndefined();
  });

  it('hides missing features when asked', () => {
    const colors = assignFeatureColors({
      values: ['tumour', '', 'stroma'],
      mode: 'categorical',
      alpha: 255,
      missingValues: { render: 'hide' },
    });
    expect(colors[1]).toEqual([0, 0, 0, 0]);
  });

  it('paints missing features an explicit colour', () => {
    const colors = assignFeatureColors({
      values: ['tumour', '', 'stroma'],
      mode: 'categorical',
      alpha: 255,
      missingValues: { render: GREY },
    });
    expect(colors[1]).toEqual(GREY);
  });

  it('treats configured sentinels as missing, so they are not a category', () => {
    const withSentinel = assignFeatureColors({
      values: ['tumour', 'NA', 'stroma'],
      mode: 'categorical',
      alpha: 255,
      categoricalPalette: [
        [255, 0, 0],
        [0, 255, 0],
        [0, 0, 255],
      ],
      missingValues: { treatAsMissing: ['NA'] },
    });

    expect(withSentinel[0]).toEqual(RED);
    expect(withSentinel[1]).toBeUndefined();
    // 'stroma' is the SECOND real category, not the third — the sentinel never
    // entered the category set, so it did not consume a palette slot.
    expect(withSentinel[2]).toEqual([0, 255, 0, 255]);
  });

  it('matches sentinels after trimming, case-insensitively', () => {
    const colors = assignFeatureColors({
      values: ['  n/a  ', 'N/A', 'tumour'],
      mode: 'categorical',
      alpha: 255,
      missingValues: { treatAsMissing: ['n/a'], render: 'hide' },
    });
    expect(colors[0]).toEqual([0, 0, 0, 0]);
    expect(colors[1]).toEqual([0, 0, 0, 0]);
    expect(colors[2]).not.toEqual([0, 0, 0, 0]);
  });

  it('keeps sentinels out of the continuous extent', () => {
    // Without sentinel handling '-1' would drag the ramp's low end down and every
    // real value would bunch at the top.
    const colors = assignFeatureColors({
      values: ['-1', '10', '20'],
      mode: 'continuous',
      alpha: 255,
      missingValues: { treatAsMissing: ['-1'] },
    });
    expect(colors[0]).toBeUndefined();
    // 10 and 20 are now the ramp endpoints.
    expect(colors[1]).toEqual([0, 64, 255, 255]);
    expect(colors[2]).toEqual([255, 220, 0, 255]);
  });

  it('applies the policy when a column is entirely missing', () => {
    const colors = assignFeatureColors({
      values: ['', ''],
      mode: 'auto',
      alpha: 255,
      missingValues: { render: GREY },
    });
    expect(colors).toEqual([GREY, GREY]);
  });

  it('paints an unparseable cell as missing when the kind says numeric', () => {
    // The kind forces continuous, so a stray non-numeric cell has no ramp position;
    // the policy decides what it looks like rather than it silently disappearing.
    const colors = assignFeatureColors({
      values: ['1', 'junk', '3'],
      mode: 'auto',
      alpha: 255,
      columnKind: 'numeric',
      missingValues: { render: GREY },
    });
    expect(colors[0]).toEqual([0, 64, 255, 255]);
    expect(colors[1]).toEqual(GREY);
    expect(colors[2]).toEqual([255, 220, 0, 255]);
  });
});

describe('featureColorAt bounds', () => {
  it('refuses to read past the bytes present, whatever count claims', () => {
    // `count` is the caller's claim about its own buffer. Trusting it alone
    // returned a tuple of undefineds typed as a colour, which reaches deck as a
    // malformed attribute rather than as an error anyone can see.
    const lying = { colors: new Uint8Array([1, 2, 3, 4]), count: 100 };
    expect(featureColorAt(lying, 0)).toEqual([1, 2, 3, 4]);
    expect(featureColorAt(lying, 1)).toBeUndefined();
    expect(featureColorAt(lying, 99)).toBeUndefined();
  });

  it('still honours a count smaller than the buffer', () => {
    const padded = { colors: new Uint8Array(8), count: 1 };
    expect(featureColorAt(padded, 0)).toEqual([0, 0, 0, 0]);
    expect(featureColorAt(padded, 1)).toBeUndefined();
  });
});
