import { describe, expect, it } from 'vitest';
import {
  buildShapeFillColorByFeatureId,
  resolveShapeFillColorMode,
} from '../src/SpatialCanvas/shapeColorEncoding.js';

describe('shape fill colour encoding', () => {
  it('maps categorical values deterministically through feature row indices', () => {
    const colors = buildShapeFillColorByFeatureId({
      featureIds: ['cell-a', 'cell-b', 'cell-c', 'cell-d'],
      rowIndexByFeatureIndex: new Int32Array([1, 0, 1, 2]),
      column: ['type-x', 'type-y', 'type-z'],
      mode: 'categorical',
      alpha: 180,
    });

    expect(colors).toEqual({
      'cell-a': [0, 0, 255, 180],
      'cell-b': [0, 255, 0, 180],
      'cell-c': [0, 0, 255, 180],
      'cell-d': [255, 0, 255, 180],
    });
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

  it('prefers feature-id table row mappings when render data row indices are unavailable', () => {
    const colors = buildShapeFillColorByFeatureId({
      featureIds: ['circle-a', 'circle-b'],
      rowIndexByFeatureIndex: new Int32Array([-1, -1]),
      rowIndexByFeatureId: new Map([
        ['circle-a', 1],
        ['circle-b', 0],
      ]),
      column: ['type-x', 'type-y'],
      mode: 'categorical',
      alpha: 180,
    });

    expect(colors).toEqual({
      'circle-a': [0, 0, 255, 180],
      'circle-b': [0, 255, 0, 180],
    });
  });

  it('prefers feature-index row alignment over colliding numeric feature ids', () => {
    const colors = buildShapeFillColorByFeatureId({
      featureIds: ['0', '1', '2'],
      rowIndexByFeatureIndex: new Int32Array([0, 1, 2]),
      rowIndexByFeatureId: new Map([
        ['1', 0],
        ['5', 1],
        ['99', 2],
      ]),
      column: ['type-a', 'type-b', 'type-c'],
      mode: 'categorical',
      alpha: 180,
    });

    expect(colors).toEqual({
      '0': [0, 0, 255, 180],
      '1': [0, 255, 0, 180],
      '2': [255, 0, 255, 180],
    });
  });

  it('treats mixed values as categorical in auto mode', () => {
    expect(resolveShapeFillColorMode('auto', ['1', 'tumour'])).toBe('categorical');
  });
});
