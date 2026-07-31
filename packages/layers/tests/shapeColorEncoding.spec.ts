import { describe, expect, it } from 'vitest';
import { featureCodeToRgb } from '../src/pointsFeatureColor';
import {
  buildShapeFillColorByFeatureId,
  resolveShapeFillColorMode,
} from '../src/shapeColorEncoding';

/** A small fixed palette, for tests whose subject is row alignment rather than
 *  colour choice — the default scheme is procedural, so colours must be pinned. */
const FIXED_PALETTE: [number, number, number][] = [
  [0, 0, 255],
  [0, 255, 0],
  [255, 0, 255],
];

describe('shape fill colour encoding', () => {
  it('maps categorical values deterministically through feature row indices', () => {
    const colors = buildShapeFillColorByFeatureId({
      featureIds: ['cell-a', 'cell-b', 'cell-c', 'cell-d'],
      rowIndexByFeatureIndex: new Int32Array([1, 0, 1, 2]),
      column: ['type-x', 'type-y', 'type-z'],
      mode: 'categorical',
      alpha: 180,
      categoricalPalette: FIXED_PALETTE,
    });

    expect(colors).toEqual({
      'cell-a': [0, 0, 255, 180],
      'cell-b': [0, 255, 0, 180],
      'cell-c': [0, 0, 255, 180],
      'cell-d': [255, 0, 255, 180],
    });
  });

  it('defaults to the unbounded OkLab scheme', () => {
    const colors = buildShapeFillColorByFeatureId({
      featureIds: ['cell-a', 'cell-b'],
      rowIndexByFeatureIndex: new Int32Array([0, 1]),
      column: ['type-x', 'type-y'],
      mode: 'categorical',
      alpha: 180,
    });

    // The same colours points gives feature codes 0 and 1 — one scheme library-wide.
    expect(colors).toEqual({
      'cell-a': [...featureCodeToRgb(0), 180],
      'cell-b': [...featureCodeToRgb(1), 180],
    });
  });

  it('does not repeat colours across many categories', () => {
    const count = 12;
    const colors = buildShapeFillColorByFeatureId({
      featureIds: Array.from({ length: count }, (_, i) => `cell-${i}`),
      rowIndexByFeatureIndex: Int32Array.from({ length: count }, (_, i) => i),
      column: Array.from({ length: count }, (_, i) => `type-${i}`),
      mode: 'categorical',
      alpha: 255,
    });

    const distinct = new Set(Object.values(colors).map((c) => c.join(',')));
    expect(distinct.size).toBe(count);
  });

  it('auto-detects numeric values and uses a continuous ramp', () => {
    expect(resolveShapeFillColorMode('auto', ['0', '5', '10'])).toBe('continuous');

    const colors = buildShapeFillColorByFeatureId({
      featureIds: ['low', 'mid', 'high'],
      rowIndexByFeatureIndex: new Int32Array([0, 1, 2]),
      column: ['0', '5', '10'],
      mode: 'auto',
      alpha: 99,
    });

    expect(colors).toEqual({
      low: [0, 64, 255, 99],
      mid: [128, 142, 128, 99],
      high: [255, 220, 0, 99],
    });
  });

  it('handles large numeric columns without spreading values into the call stack', () => {
    const count = 150_000;
    const featureIds = Array.from({ length: count }, (_, index) => `cell-${index}`);
    const rowIndexByFeatureIndex = Int32Array.from({ length: count }, (_, index) => index);
    const column = Array.from({ length: count }, (_, index) => index);

    const colors = buildShapeFillColorByFeatureId({
      featureIds,
      rowIndexByFeatureIndex,
      column,
      mode: 'continuous',
      alpha: 180,
    });

    expect(colors['cell-0']).toEqual([0, 64, 255, 180]);
    expect(colors[`cell-${count - 1}`]).toEqual([255, 220, 0, 180]);
  });

  it('omits missing, unmatched, and empty values so defaults can render', () => {
    const colors = buildShapeFillColorByFeatureId({
      featureIds: ['empty', 'unmatched', 'nullish', 'present'],
      rowIndexByFeatureIndex: new Int32Array([0, -1, 2, 1]),
      column: ['', '5', null],
      mode: 'auto',
      alpha: 180,
    });

    expect(Object.keys(colors).sort()).toEqual(['present']);
  });

  it('uses already-resolved row alignment from core association helpers', () => {
    const colors = buildShapeFillColorByFeatureId({
      featureIds: ['circle-a', 'circle-b'],
      rowIndexByFeatureIndex: new Int32Array([1, 0]),
      column: ['type-x', 'type-y'],
      mode: 'categorical',
      alpha: 180,
      // Fixed palette: this test is about row alignment, so pin the colours.
      categoricalPalette: FIXED_PALETTE,
    });

    expect(colors).toEqual({
      'circle-a': [0, 0, 255, 180],
      'circle-b': [0, 255, 0, 180],
    });
  });

  it('does not invent rows for unresolved features', () => {
    const colors = buildShapeFillColorByFeatureId({
      featureIds: ['matched', 'unmatched'],
      rowIndexByFeatureIndex: new Int32Array([1, -1]),
      column: ['type-a', 'type-b', 'type-c'],
      mode: 'categorical',
      alpha: 180,
      categoricalPalette: FIXED_PALETTE,
    });

    expect(colors).toEqual({
      matched: [0, 0, 255, 180],
    });
  });

  it('treats mixed values as categorical in auto mode', () => {
    expect(resolveShapeFillColorMode('auto', ['1', 'tumour'])).toBe('categorical');
  });

  it('allows callers to supply their own categorical palette', () => {
    const colors = buildShapeFillColorByFeatureId({
      featureIds: ['a', 'b'],
      rowIndexByFeatureIndex: new Int32Array([0, 1]),
      column: ['x', 'y'],
      mode: 'categorical',
      alpha: 200,
      categoricalPalette: [[1, 2, 3]],
    });

    expect(colors).toEqual({
      a: [1, 2, 3, 200],
      b: [1, 2, 3, 200],
    });
  });
});

describe('numeric columns with missing values', () => {
  /**
   * `NaN` is how a float column spells NA. Before it normalised as missing, one
   * failed embedding in a `UMAP1` column flipped the whole column to categorical —
   * and categorical mode then gave every distinct float its own category, so the
   * layer rendered as noise. Regression coverage for exactly that.
   */
  const umapWithGap = [-3.421, Number.NaN, 12.87, 0.5];

  it('stays continuous when a float column contains NaN', () => {
    const colors = buildShapeFillColorByFeatureId({
      featureIds: ['a', 'b', 'c', 'd'],
      rowIndexByFeatureIndex: new Int32Array([0, 1, 2, 3]),
      column: umapWithGap,
      mode: 'auto',
      alpha: 255,
    });

    // Four distinct floats would be four palette entries if this went categorical;
    // on the ramp the extremes are the ramp endpoints.
    expect(colors.a).toEqual([0, 64, 255, 255]);
    expect(colors.c).toEqual([255, 220, 0, 255]);
    // The NaN cell has no value, so it keeps the layer default rather than
    // being coloured as if it were a category of its own.
    expect(colors.b).toBeUndefined();
  });

  it('treats Infinity as missing too', () => {
    expect(resolveShapeFillColorMode('auto', ['1', String(Number.POSITIVE_INFINITY)])).toBe(
      'categorical'
    );

    // ...but only the string survives to that check; a real Infinity normalises away.
    const colors = buildShapeFillColorByFeatureId({
      featureIds: ['a', 'b'],
      rowIndexByFeatureIndex: new Int32Array([0, 1]),
      column: [1, Number.POSITIVE_INFINITY],
      mode: 'auto',
      alpha: 255,
    });
    expect(colors.b).toBeUndefined();
    // A single usable value: the ramp collapses to its midpoint rather than
    // dividing by a zero range.
    expect(colors.a).toEqual([128, 142, 128, 255]);
  });

  it('leaves a genuine "NaN" string category alone', () => {
    // In a string column there is no way to tell a missing float from a category
    // spelled that way, so it stays a category.
    const colors = buildShapeFillColorByFeatureId({
      featureIds: ['a', 'b'],
      rowIndexByFeatureIndex: new Int32Array([0, 1]),
      column: ['NaN', 'tumour'],
      mode: 'auto',
      alpha: 255,
      categoricalPalette: FIXED_PALETTE,
    });

    expect(colors.a).toEqual([0, 0, 255, 255]);
    expect(colors.b).toEqual([0, 255, 0, 255]);
  });
});
