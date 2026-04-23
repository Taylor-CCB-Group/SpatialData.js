import { describe, expect, it } from 'vitest';
import {
  Affine,
  buildMatrix4FromTransforms,
  composeTransforms,
} from '../src/transformations/transformations.js';

describe('Affine', () => {
  it('maps full-axis affines onto spatial x/y dimensions by axis name', () => {
    const transform = new Affine(
      [
        [1.0, 0.0, 0.0, 0.0],
        [0.0, 1.2887244761014256, 0.0047835073711511, -75.48202253664931],
        [0.0, 0.0047835073711511, -1.2887244761014256, 16309.102788536682],
      ],
      {
        name: 'cyx',
        axes: [
          { name: 'c', type: 'channel' },
          { name: 'y', type: 'space' },
          { name: 'x', type: 'space' },
        ],
      },
      {
        name: 'global',
        axes: [
          { name: 'c', type: 'channel' },
          { name: 'x', type: 'space' },
          { name: 'y', type: 'space' },
        ],
      }
    );

    const mapped = transform.toMatrix().transformPoint([100, 200, 0]);
    const expectedX = 0.0047835073711511 * 100 + 1.2887244761014256 * 200 - 75.48202253664931;
    const expectedY = -1.2887244761014256 * 100 + 0.0047835073711511 * 200 + 16309.102788536682;

    expect(mapped[0]).toBeCloseTo(expectedX);
    expect(mapped[1]).toBeCloseTo(expectedY);
    expect(mapped[2]).toBeCloseTo(0);
  });

  it('preserves spatial-only 2d affines', () => {
    const transform = new Affine(
      [
        [2, 0, 10],
        [0, 3, 20],
      ],
      {
        name: 'xy',
        axes: [
          { name: 'x', type: 'space' },
          { name: 'y', type: 'space' },
        ],
      },
      {
        name: 'xy',
        axes: [
          { name: 'x', type: 'space' },
          { name: 'y', type: 'space' },
        ],
      }
    );

    const mapped = transform.toMatrix().transformPoint([4, 5, 0]);
    expect(mapped[0]).toBeCloseTo(18);
    expect(mapped[1]).toBeCloseTo(35);
    expect(mapped[2]).toBeCloseTo(0);
  });
});

describe('transform composition order', () => {
  it('applies explicit sequence transformations in listed order', () => {
    const matrix = buildMatrix4FromTransforms([
      {
        type: 'sequence',
        transformations: [
          { type: 'scale', scale: [2, 2] },
          { type: 'translation', translation: [10, 20] },
        ],
      },
    ]);

    expect(matrix.transformPoint([1, 1, 0])).toEqual([12, 22, 0]);
  });

  it('applies top-level transform arrays in listed order', () => {
    const matrix = buildMatrix4FromTransforms([
      { type: 'scale', scale: [2, 2] },
      { type: 'translation', translation: [10, 20] },
    ]);

    expect(matrix.transformPoint([1, 1, 0])).toEqual([12, 22, 0]);
  });

  it('applies dataset transforms before element transforms', () => {
    const matrix = composeTransforms(
      [{ type: 'translation', translation: [10, 20] }],
      [{ type: 'scale', scale: [2, 2] }]
    );

    expect(matrix?.transformPoint([1, 1, 0])).toEqual([12, 22, 0]);
  });
});
