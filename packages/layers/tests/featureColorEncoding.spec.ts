import { describe, expect, it } from 'vitest';
import {
  assignFeatureColors,
  featureColorAt,
  featureColorSchemeSignature,
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

    // Two real categories take the first two palette slots between them: the
    // sentinel never entered the category set, so it did not consume one. (Which
    // of the two is slot 0 is decided by value order — 'stroma' before 'tumour'.)
    expect(withSentinel[0]).toEqual([0, 255, 0, 255]);
    expect(withSentinel[1]).toBeUndefined();
    expect(withSentinel[2]).toEqual(RED);
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

/**
 * The encoding must be a function of the COLUMN, not of the features that
 * happened to load. Everything here is a case where it used not to be, and where
 * the symptom was two views of one annotation disagreeing about what a colour
 * means — which reads as a data difference, not as a bug.
 */
describe('an encoding that does not depend on which features loaded', () => {
  const palette: [number, number, number][] = [
    [255, 0, 0],
    [0, 255, 0],
    [0, 0, 255],
  ];

  it('gives a category the same colour whatever order the features arrive in', () => {
    const forward = assignFeatureColors({
      values: ['tumour', 'stroma'],
      mode: 'categorical',
      alpha: 255,
      categoricalPalette: palette,
    });
    const reversed = assignFeatureColors({
      values: ['stroma', 'tumour'],
      mode: 'categorical',
      alpha: 255,
      categoricalPalette: palette,
    });

    expect(forward[0]).toEqual(reversed[1]);
    expect(forward[1]).toEqual(reversed[0]);
  });

  it('does not shift a category when another one is absent from the view', () => {
    // A layer over a subset that happens to contain no `stroma` must still draw
    // `tumour` in the colour the full view draws it in.
    const all = assignFeatureColors({
      values: ['alpha', 'stroma', 'tumour'],
      mode: 'categorical',
      alpha: 255,
      categoricalPalette: palette,
    });
    const subset = assignFeatureColors({
      values: ['alpha', 'tumour'],
      mode: 'categorical',
      alpha: 255,
      categoricalPalette: palette,
    });

    expect(subset[0]).toEqual(all[0]);
    // Positional palettes cannot survive this — `tumour` genuinely is the second
    // category present. Naming the colours is the only fix, which is what the
    // named-palette tests below cover; here we pin the shift so it stays visible.
    expect(subset[1]).not.toEqual(all[2]);
  });

  it('orders numeric-looking categories numerically, not lexicographically', () => {
    // Cluster 10 belongs after cluster 9. Under string order it lands between 1
    // and 2, and a 12-cluster annotation renders with a shuffled palette.
    const colors = assignFeatureColors({
      values: ['1', '2', '10'],
      mode: 'categorical',
      alpha: 255,
      categoricalPalette: palette,
    });

    expect(colors).toEqual([
      [255, 0, 0, 255],
      [0, 255, 0, 255],
      [0, 0, 255, 255],
    ]);
  });

  it('holds the ramp to a pinned domain instead of the loaded extent', () => {
    const pinned = { mode: 'continuous' as const, alpha: 255, numericDomain: [0, 10] as const };

    // The same value, on two layers covering different parts of the column.
    const full = assignFeatureColors({ values: ['0', '3', '10'], ...pinned });
    const subset = assignFeatureColors({ values: ['0', '3'], ...pinned });

    expect(subset[1]).toEqual(full[1]);
    // And without the domain it does not hold: in the subset, `3` is the top of
    // the range rather than three tenths of the way up it.
    const unpinned = assignFeatureColors({
      values: ['0', '3'],
      mode: 'continuous',
      alpha: 255,
    });
    expect(unpinned[1]).not.toEqual(full[1]);
  });

  it('clamps values outside a pinned domain rather than extrapolating', () => {
    const colors = assignFeatureColors({
      values: ['-100', '0', '10', '900'],
      mode: 'continuous',
      alpha: 255,
      numericDomain: [0, 10],
    });

    expect(colors[0]).toEqual(colors[1]);
    expect(colors[3]).toEqual(colors[2]);
  });
});

describe('a palette that names its categories', () => {
  it('colours by value, so two views agree even on different category sets', () => {
    const byValue = { tumour: [200, 30, 30] as [number, number, number] };
    const all = assignFeatureColors({
      values: ['alpha', 'stroma', 'tumour'],
      mode: 'categorical',
      alpha: 255,
      categoricalPalette: { byValue },
    });
    const subset = assignFeatureColors({
      values: ['tumour'],
      mode: 'categorical',
      alpha: 255,
      categoricalPalette: { byValue },
    });

    expect(all[2]).toEqual([200, 30, 30, 255]);
    expect(subset[0]).toEqual(all[2]);
  });

  it('gives an unnamed category its own hue rather than merging them', () => {
    const colors = assignFeatureColors({
      values: ['tumour', 'stroma', 'other'],
      mode: 'categorical',
      alpha: 255,
      categoricalPalette: { byValue: { tumour: [200, 30, 30] } },
    });

    expect(colors[1]).not.toEqual(colors[2]);
  });

  it('honours an explicit fallback colour for everything unnamed', () => {
    const colors = assignFeatureColors({
      values: ['tumour', 'stroma', 'other'],
      mode: 'categorical',
      alpha: 255,
      categoricalPalette: { byValue: { tumour: [200, 30, 30] }, fallback: [90, 90, 90] },
    });

    expect(colors[0]).toEqual([200, 30, 30, 255]);
    expect(colors[1]).toEqual([90, 90, 90, 255]);
    expect(colors[2]).toEqual([90, 90, 90, 255]);
  });

  it('does not name missing values into a category', () => {
    // A named palette must not resurrect a sentinel: `isMissing` runs first, so an
    // entry for the sentinel string is simply never consulted.
    const colors = assignFeatureColors({
      values: ['tumour', 'NA'],
      mode: 'categorical',
      alpha: 255,
      categoricalPalette: { byValue: { tumour: [200, 30, 30], NA: [1, 2, 3] } },
      missingValues: { treatAsMissing: ['NA'] },
    });

    expect(colors[1]).toBeUndefined();
  });
});

describe('featureColorSchemeSignature', () => {
  it('separates schemes that differ only in a pinned domain', () => {
    expect(featureColorSchemeSignature({ numericDomain: [0, 10] })).not.toBe(
      featureColorSchemeSignature({ numericDomain: [0, 20] })
    );
  });

  it('reads two equal named palettes as one scheme whatever order they were built in', () => {
    // Object key order is insertion order, and a host rebuilding its palette per
    // render need not insert in a stable one. A signature that moved would rebuild
    // the whole colour buffer on renders where nothing changed.
    const a = featureColorSchemeSignature({
      categoricalPalette: { byValue: { tumour: [1, 2, 3], stroma: [4, 5, 6] } },
    });
    const b = featureColorSchemeSignature({
      categoricalPalette: { byValue: { stroma: [4, 5, 6], tumour: [1, 2, 3] } },
    });

    expect(a).toBe(b);
  });

  it('still separates named palettes that differ in a colour', () => {
    expect(
      featureColorSchemeSignature({ categoricalPalette: { byValue: { tumour: [1, 2, 3] } } })
    ).not.toBe(
      featureColorSchemeSignature({ categoricalPalette: { byValue: { tumour: [9, 9, 9] } } })
    );
  });
});

describe('a ramp with more than two stops', () => {
  const diverging: [number, number, number][] = [
    [0, 0, 255],
    [255, 255, 255],
    [255, 0, 0],
  ];

  it('passes through the middle stop at the middle of the domain', () => {
    // The whole reason to allow more than two: a diverging ramp's midpoint is the
    // meaning. Interpolating its endpoints alone would put grey-purple here.
    const colors = assignFeatureColors({
      values: ['0', '5', '10'],
      mode: 'continuous',
      alpha: 255,
      numericRamp: diverging,
      numericDomain: [0, 10],
    });

    expect(colors).toEqual([
      [0, 0, 255, 255],
      [255, 255, 255, 255],
      [255, 0, 0, 255],
    ]);
  });

  it('lands on the last stop at the top of the domain, not past it', () => {
    const colors = assignFeatureColors({
      values: ['10'],
      mode: 'continuous',
      alpha: 255,
      numericRamp: diverging,
      numericDomain: [0, 10],
    });

    expect(colors[0]).toEqual([255, 0, 0, 255]);
  });

  it('spreads a long tail with a symlog scale', () => {
    const values = ['0', '1', '10', '1000'];
    const opts = {
      mode: 'continuous' as const,
      alpha: 255,
      numericRamp: diverging,
      numericDomain: [0, 1000] as const,
    };

    const linear = assignFeatureColors({ values, ...opts });
    const log = assignFeatureColors({ values, ...opts, numericScale: 'symlog' as const });

    /** Largest per-channel difference — how far apart two colours actually look. */
    const apart = (a?: number[], b?: number[]) =>
      Math.max(...[0, 1, 2].map((i) => Math.abs((a?.[i] ?? 0) - (b?.[i] ?? 0))));

    // Linear: 1 and 10 both sit within 1% of the bottom of the domain, so the
    // whole low end of the column collapses into one indistinguishable colour.
    expect(apart(linear[1], linear[0])).toBeLessThan(10);
    expect(apart(linear[2], linear[0])).toBeLessThan(10);
    // Symlog pulls them apart into colours a reader can actually tell apart.
    expect(apart(log[1], log[0])).toBeGreaterThan(40);
    expect(apart(log[2], log[1])).toBeGreaterThan(40);
    // The endpoints still pin to the ends of the ramp.
    expect(log[0]).toEqual([0, 0, 255, 255]);
    expect(log[3]).toEqual([255, 0, 0, 255]);
  });

  it('handles a domain that crosses zero, where a plain log could not', () => {
    const colors = assignFeatureColors({
      values: ['-100', '0', '100'],
      mode: 'continuous',
      alpha: 255,
      numericRamp: diverging,
      numericDomain: [-100, 100],
      numericScale: 'symlog',
    });

    expect(colors[0]).toEqual([0, 0, 255, 255]);
    expect(colors[1]).toEqual([255, 255, 255, 255]);
    expect(colors[2]).toEqual([255, 0, 0, 255]);
  });
});

/**
 * A scheme arrives from a saved Render Stack, so its type is a claim about JSON
 * rather than a guarantee. Every case here used to reach the colour arithmetic and
 * fail there — `Cannot read properties of undefined (reading '0')`, several frames
 * from the malformed field, inside a bundled dependency. Wrong colours can be
 * reported by whoever sees them; that TypeError cannot.
 */
describe('a scheme that does not match its own type', () => {
  const malformed = (categoricalPalette: unknown) =>
    assignFeatureColors({
      values: ['tumour', 'stroma'],
      mode: 'categorical',
      alpha: 255,
      categoricalPalette: categoricalPalette as never,
    });

  it('falls back to the default scheme for a palette object with no byValue', () => {
    const colors = malformed({ fallback: 'oklab' });

    expect(colors[0]).toBeDefined();
    expect(colors[1]).toBeDefined();
    expect(colors[0]).not.toEqual(colors[1]);
  });

  it('falls back to the default scheme for a null palette', () => {
    // The sharp edge: `typeof null === 'object'` and `Array.isArray(null)` is
    // false, so `null` reads as a named palette to any guard that does not say
    // otherwise — and then the destructure throws before any colour is assigned.
    // `{"categoricalPalette": null}` is a thing JSON says.
    const colors = malformed(null);

    expect(colors[0]).toBeDefined();
    expect(colors[1]).toBeDefined();
    expect(colors[0]).not.toEqual(colors[1]);
  });

  it('takes a signature for a null palette instead of throwing on one', () => {
    // Same root cause, different entry point: the signature helper narrows with
    // the same guard, so a null palette used to take the cache key down with it.
    expect(() => featureColorSchemeSignature({ categoricalPalette: null as never })).not.toThrow();
  });

  it('survives a list with a hole in it', () => {
    const colors = malformed([[1, 2, 3], undefined]);

    expect(colors[0]).toBeDefined();
    expect(colors[1]).toBeDefined();
  });

  it('survives a ramp with fewer stops than its type allows', () => {
    const one = assignFeatureColors({
      values: ['0', '5', '10'],
      mode: 'continuous',
      alpha: 255,
      numericRamp: [[7, 8, 9]] as never,
    });

    expect(one).toEqual([
      [7, 8, 9, 255],
      [7, 8, 9, 255],
      [7, 8, 9, 255],
    ]);
  });

  it('survives an empty ramp', () => {
    const none = assignFeatureColors({
      values: ['0', '10'],
      mode: 'continuous',
      alpha: 255,
      numericRamp: [] as never,
    });

    expect(none[0]).toBeDefined();
    expect(none[1]).toBeDefined();
  });
});
