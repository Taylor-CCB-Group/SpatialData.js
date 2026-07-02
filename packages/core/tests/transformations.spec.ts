import { describe, expect, it } from 'vitest';
import {
  Affine,
  MapAxis,
  Rotation,
  Scale,
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

describe('Rotation', () => {
  it('matches the RFC-5 conformance case (45deg rotation, y/x axis order)', () => {
    const yx = {
      name: 'input',
      axes: [
        { name: 'y', type: 'space' as const },
        { name: 'x', type: 'space' as const },
      ],
    };
    const transform = new Rotation(
      [
        [0.70710678, -0.70710678],
        [0.70710678, 0.70710678],
      ],
      yx,
      yx
    );

    // Raw input point [y=1, x=1] as an x/y/z vector (Matrix4 space): (x=1, y=1, 0).
    const mapped = transform.toMatrix().transformPoint([1, 1, 0]);
    // Expect raw output [y=0, x=1.41421356], i.e. xyz vector (x=1.41421356, y=0, 0).
    expect(mapped[0]).toBeCloseTo(1.41421356);
    expect(mapped[1]).toBeCloseTo(0);
  });
});

describe('MapAxis', () => {
  it('matches the RFC-5 conformance case (swap y/x)', () => {
    const yx = {
      name: 'input',
      axes: [
        { name: 'y', type: 'space' as const },
        { name: 'x', type: 'space' as const },
      ],
    };
    // output[0] (y) <- input[1] (x); output[1] (x) <- input[0] (y)
    const transform = new MapAxis([1, 0], yx, yx);

    // Raw input point [y=1, x=2] as an x/y/z vector (Matrix4 space): (x=2, y=1, 0).
    const mapped = transform.toMatrix().transformPoint([2, 1, 0]);
    // Expect raw output [y=2, x=1], i.e. xyz vector (x=1, y=2, 0).
    expect(mapped[0]).toBeCloseTo(1); // x_out
    expect(mapped[1]).toBeCloseTo(2); // y_out
  });
});

describe('inverse', () => {
  it('inverts a scale transformation', () => {
    const transform = new Scale([2, 4]);
    const inverted = transform.inverse();
    expect(inverted.transformPoint([2, 4, 0])).toEqual([1, 1, 0]);
  });

  it('throws for a singular (non-invertible) transformation', () => {
    const transform = new Scale([0, 4]);
    expect(() => transform.inverse()).toThrow();
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
