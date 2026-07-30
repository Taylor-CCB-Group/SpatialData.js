import { describe, expect, it } from 'vitest';
import {
  buildLabelColorLut,
  buildLabelFillColorByFeatureId,
  isLabelVisibleInLut,
  parseLabelId,
} from '../src/labelColorEncoding';

const WHITE: [number, number, number] = [255, 255, 255];

function rgbaAt(colors: Uint8Array, labelId: number): number[] {
  return Array.from(colors.subarray(labelId * 4, labelId * 4 + 4));
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
    });

    expect(colors).toEqual({
      '1': [0, 0, 255, 255],
      '2': [0, 255, 0, 255],
      '3': [0, 0, 255, 255],
    });
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

    expect(lut?.labelCount).toBe(4);
    expect(rgbaAt(lut?.colors as Uint8Array, 3)).toEqual([10, 20, 30, 255]);
    // Labels 0..2 are addressable but unannotated: default colour, fully opaque.
    expect(rgbaAt(lut?.colors as Uint8Array, 1)).toEqual([255, 255, 255, 255]);
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

    expect(rgbaAt(lut?.colors as Uint8Array, 1)).toEqual([255, 255, 255, 102]);
    expect(rgbaAt(lut?.colors as Uint8Array, 2)).toEqual([255, 255, 255, 0]);
  });

  it('lets hide win over fade for a label in both sets', () => {
    const lut = buildLabelColorLut({
      featureState: { hiddenFeatureIds: ['5'], fadedFeatureIds: ['5'] },
      defaultColor: WHITE,
    });

    expect(rgbaAt(lut?.colors as Uint8Array, 5)).toEqual([255, 255, 255, 0]);
  });

  it('filters without any colouring at all', () => {
    const lut = buildLabelColorLut({
      featureState: { hiddenFeatureIds: ['1', '3'] },
      defaultColor: [7, 8, 9],
    });

    expect(rgbaAt(lut?.colors as Uint8Array, 1)).toEqual([7, 8, 9, 0]);
    expect(rgbaAt(lut?.colors as Uint8Array, 2)).toEqual([7, 8, 9, 255]);
    expect(rgbaAt(lut?.colors as Uint8Array, 3)).toEqual([7, 8, 9, 0]);
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

    expect(lut?.labelCount).toBe(3);
    expect(rgbaAt(lut?.colors as Uint8Array, 2)).toEqual([255, 255, 255, 0]);
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
