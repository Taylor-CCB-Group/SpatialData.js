import { Matrix4 } from '@math.gl/core';
import { describe, expect, it } from 'vitest';
import { modelMatrixUniformScale } from '../src/pointsScatterLayer.js';

/**
 * Point size is expressed in the ELEMENT's coordinate units. Deck applies
 * `modelMatrix` to positions but not to a `'common'`-unit radius, so the layer
 * folds the matrix scale into `radiusScale` itself. These pin that factor against
 * transforms taken from real SpatialData elements.
 */
describe('modelMatrixUniformScale', () => {
  it('reads the scale of a millimetre affine (points were ~8300x oversized)', () => {
    const scale = 0.00012028094454887216;
    expect(modelMatrixUniformScale(new Matrix4().scale([scale, scale, 1]))).toBeCloseTo(scale, 12);
  });

  it('reads a plain upscale transform', () => {
    const scale = 4.705882352941177;
    expect(modelMatrixUniformScale(new Matrix4().scale([scale, scale, 1]))).toBeCloseTo(scale, 9);
  });

  it('is 1 for identity, so untransformed elements are unaffected', () => {
    expect(modelMatrixUniformScale(new Matrix4())).toBe(1);
  });

  it('is 1 for a missing matrix', () => {
    expect(modelMatrixUniformScale(null)).toBe(1);
    expect(modelMatrixUniformScale(undefined)).toBe(1);
  });

  it('takes the geometric mean of anisotropic axes', () => {
    expect(modelMatrixUniformScale(new Matrix4().scale([4, 9, 1]))).toBeCloseTo(6, 9);
  });

  it('ignores translation', () => {
    const m = new Matrix4().translate([1000, -2000, 0]).scale([3, 3, 1]);
    expect(modelMatrixUniformScale(m)).toBeCloseTo(3, 9);
  });

  it('is unaffected by rotation (basis length, not raw elements)', () => {
    const m = new Matrix4().rotateZ(Math.PI / 4).scale([2, 2, 1]);
    expect(modelMatrixUniformScale(m)).toBeCloseTo(2, 9);
  });

  it('falls back to 1 for a degenerate (zero) matrix rather than collapsing points', () => {
    expect(modelMatrixUniformScale(new Matrix4().scale([0, 0, 0]))).toBe(1);
  });
});
