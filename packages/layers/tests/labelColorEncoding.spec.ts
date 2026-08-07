import { describe, expect, it } from 'vitest';
import {
  buildLabelColorLut,
  buildLabelFillColorByFeatureId,
  isLabelVisibleInLut,
  NO_HIGHLIGHTED_LABEL,
  parseLabelId,
  resolveHighlightedLabel,
} from '../src/labelColorEncoding';
import { featureCodeToRgb } from '../src/pointsFeatureColor';
import { buildShapeFillColorByFeatureId } from '../src/shapeColorEncoding';

/** A small fixed palette, for tests whose subject is row alignment rather than
 *  colour choice — the default scheme is procedural, so colours must be pinned. */
const FIXED_PALETTE: [number, number, number][] = [
  [0, 0, 255],
  [0, 255, 0],
  [255, 0, 255],
];

const WHITE: [number, number, number] = [255, 255, 255];

function rgbaAt(colors: Uint8Array, labelId: number): number[] {
  return Array.from(colors.subarray(labelId * 4, labelId * 4 + 4));
}

/** Narrow a built LUT, failing loudly rather than asserting the type away. */
function lutColors(lut: ReturnType<typeof buildLabelColorLut>): Uint8Array {
  if (!lut) throw new Error('expected buildLabelColorLut to produce a table');
  return lut.colors;
}

describe('label fill colour encoding', () => {
  it('maps categorical values through the associated table rows, keyed by label id', () => {
    const colors = buildLabelFillColorByFeatureId({
      rowIds: ['1', '2', '3'],
      rowIndexByFeatureId: new Map([
        ['1', 0],
        ['2', 1],
        ['3', 2],
      ]),
      column: ['tumour', 'stroma', 'tumour'],
      mode: 'categorical',
      categoricalPalette: FIXED_PALETTE,
    });

    expect(colors).toEqual({
      // `stroma` sorts before `tumour`, so it takes palette slot 0.
      '1': [0, 255, 0, 255],
      '2': [0, 0, 255, 255],
      '3': [0, 255, 0, 255],
    });
  });

  it('gives a label the same colour the same category gets on a shapes layer', () => {
    // The two kinds walk their features in orders neither controls: a labels layer
    // walks the raster's ids, a shapes layer walks the loader's geometry. Here they
    // walk the SAME two rows in OPPOSITE orders, which is the whole test — under
    // first-seen category indices `tumour` would be slot 0 on one kind and slot 1
    // on the other, and one annotation would render in two different colour schemes.
    const column = ['tumour', 'stroma'];

    const labelColors = buildLabelFillColorByFeatureId({
      rowIds: ['1', '2'],
      rowIndexByFeatureId: new Map([
        ['1', 0],
        ['2', 1],
      ]),
      column,
      mode: 'categorical',
    });
    const shapeColors = buildShapeFillColorByFeatureId({
      featureIds: ['stroma-shape', 'tumour-shape'],
      rowIndexByFeatureIndex: new Int32Array([1, 0]),
      column,
      mode: 'categorical',
      alpha: 255,
    });

    expect(labelColors['1']).toEqual(shapeColors['tumour-shape']);
    expect(labelColors['2']).toEqual(shapeColors['stroma-shape']);
    // Default scheme, no palette passed: the OkLab colours points uses for codes
    // 0 and 1. One scheme across points, shapes and labels.
    expect(labelColors['2']).toEqual([...featureCodeToRgb(0), 255]);
    expect(labelColors['1']).toEqual([...featureCodeToRgb(1), 255]);
  });

  it('uses the same palette and ramp as shapes for the same column', () => {
    const colors = buildLabelFillColorByFeatureId({
      rowIds: ['1', '2', '3'],
      rowIndexByFeatureId: new Map([
        ['1', 0],
        ['2', 1],
        ['3', 2],
      ]),
      column: ['0', '5', '10'],
      mode: 'auto',
      alpha: 99,
    });

    expect(colors).toEqual({
      '1': [0, 64, 255, 99],
      '2': [128, 142, 128, 99],
      '3': [255, 220, 0, 99],
    });
  });

  it('omits labels with no matching row so the default colour can render', () => {
    const colors = buildLabelFillColorByFeatureId({
      rowIds: ['1', '2'],
      rowIndexByFeatureId: new Map([['2', 0]]),
      column: ['stroma'],
      mode: 'categorical',
    });

    expect(Object.keys(colors)).toEqual(['2']);
  });
});

describe('label colour lookup table', () => {
  it('fills unannotated labels with the default colour at full opacity', () => {
    const lut = buildLabelColorLut({
      featureState: { fillColorByFeatureId: { '3': [10, 20, 30, 255] } },
      defaultColor: WHITE,
    });

    expect(lut?.count).toBe(4);
    expect(rgbaAt(lutColors(lut), 3)).toEqual([10, 20, 30, 255]);
    // Labels 0..2 are addressable but unannotated: default colour, fully opaque.
    expect(rgbaAt(lutColors(lut), 1)).toEqual([255, 255, 255, 255]);
  });

  it('hides hidden labels and scales faded ones', () => {
    const lut = buildLabelColorLut({
      featureState: {
        hiddenFeatureIds: ['2'],
        fadedFeatureIds: ['1'],
        filteredOpacityMultiplier: 0.4,
      },
      defaultColor: WHITE,
    });

    expect(rgbaAt(lutColors(lut), 1)).toEqual([255, 255, 255, 102]);
    expect(rgbaAt(lutColors(lut), 2)).toEqual([255, 255, 255, 0]);
  });

  it('lets hide win over fade for a label in both sets', () => {
    const lut = buildLabelColorLut({
      featureState: { hiddenFeatureIds: ['5'], fadedFeatureIds: ['5'] },
      defaultColor: WHITE,
    });

    expect(rgbaAt(lutColors(lut), 5)).toEqual([255, 255, 255, 0]);
  });

  it('filters without any colouring at all', () => {
    const lut = buildLabelColorLut({
      featureState: { hiddenFeatureIds: ['1', '3'] },
      defaultColor: [7, 8, 9],
    });

    expect(rgbaAt(lutColors(lut), 1)).toEqual([7, 8, 9, 0]);
    expect(rgbaAt(lutColors(lut), 2)).toEqual([7, 8, 9, 255]);
    expect(rgbaAt(lutColors(lut), 3)).toEqual([7, 8, 9, 0]);
  });

  it('declines to build when the feature state addresses nothing', () => {
    expect(buildLabelColorLut({ featureState: undefined, defaultColor: WHITE })).toBeUndefined();
    expect(buildLabelColorLut({ featureState: {}, defaultColor: WHITE })).toBeUndefined();
    // Ids that are not non-negative integers cannot address a raster value.
    expect(
      buildLabelColorLut({
        featureState: { hiddenFeatureIds: ['cell_7', '-1', '1.5'] },
        defaultColor: WHITE,
      })
    ).toBeUndefined();
  });

  it('caps the table at the caller-supplied maximum label id', () => {
    const lut = buildLabelColorLut({
      featureState: { hiddenFeatureIds: ['2', '9999'] },
      defaultColor: WHITE,
      maxLabelId: 10,
    });

    expect(lut?.count).toBe(3);
    expect(rgbaAt(lutColors(lut), 2)).toEqual([255, 255, 255, 0]);
  });

  it('reports visibility for the picking path', () => {
    const lut = buildLabelColorLut({
      featureState: { hiddenFeatureIds: ['2'] },
      defaultColor: WHITE,
    });

    expect(isLabelVisibleInLut(lut, 2)).toBe(false);
    expect(isLabelVisibleInLut(lut, 1)).toBe(true);
    // A label past the end of the table is unannotated, not hidden.
    expect(isLabelVisibleInLut(lut, 900)).toBe(true);
    expect(isLabelVisibleInLut(undefined, 2)).toBe(true);
  });
});

describe('parseLabelId', () => {
  it('accepts only non-negative integer ids', () => {
    expect(parseLabelId('0')).toBe(0);
    expect(parseLabelId('42')).toBe(42);
    expect(parseLabelId('')).toBeUndefined();
    expect(parseLabelId('-1')).toBeUndefined();
    expect(parseLabelId('1.5')).toBeUndefined();
    expect(parseLabelId('cell_1')).toBeUndefined();
    expect(parseLabelId('1e3')).toBeUndefined();
  });
});

describe('resolveHighlightedLabel', () => {
  it('passes through a real label id', () => {
    expect(resolveHighlightedLabel(7)).toBe(7);
  });

  it('treats absent, non-finite and background ids as no highlight', () => {
    expect(resolveHighlightedLabel(undefined)).toBe(NO_HIGHLIGHTED_LABEL);
    expect(resolveHighlightedLabel(null)).toBe(NO_HIGHLIGHTED_LABEL);
    expect(resolveHighlightedLabel(Number.NaN)).toBe(NO_HIGHLIGHTED_LABEL);
    expect(resolveHighlightedLabel(Number.POSITIVE_INFINITY)).toBe(NO_HIGHLIGHTED_LABEL);
    // Label 0 is background: never drawn, so never hovered. A caller that spells
    // "nothing picked" as 0 rather than -1 must not light up the background.
    expect(resolveHighlightedLabel(0)).toBe(NO_HIGHLIGHTED_LABEL);
    expect(resolveHighlightedLabel(-1)).toBe(NO_HIGHLIGHTED_LABEL);
  });

  it('rounds, so the float the shader compares against is exact', () => {
    expect(resolveHighlightedLabel(3.4)).toBe(3);
    expect(resolveHighlightedLabel(3.6)).toBe(4);
  });

  it('refuses a label the table hides', () => {
    const lut = buildLabelColorLut({
      featureState: { hiddenFeatureIds: ['2'] },
      defaultColor: [255, 255, 255],
    });
    // Picking already refuses a hidden label; this catches an id that went stale
    // between the pick and the frame, which the shader could not catch itself.
    expect(resolveHighlightedLabel(2, lut)).toBe(NO_HIGHLIGHTED_LABEL);
    expect(resolveHighlightedLabel(1, lut)).toBe(1);
    // Past the end of the table is unannotated, not hidden.
    expect(resolveHighlightedLabel(900, lut)).toBe(900);
  });
});
