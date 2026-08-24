import { Matrix4 } from '@math.gl/core';
import { describe, expect, it } from 'vitest';
import { modelMatrixUniformScale, renderColumnarScatterLayer } from '../src/pointsScatterLayer.js';

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

/**
 * The Morton tile path used to size in fixed PIXELS (`radiusUnits: 'pixels'`,
 * transform scale forced to 1) on the reasoning that tiles are already
 * viewport-bounded. Two consequences, both user-visible: `pointSize` meant
 * something different depending on a checkbox, and a zoomed-out tiled layer drew
 * every one of its millions of points as a fixed screen dot — density saturated to
 * a flat mass, and every tile seam and acquisition boundary hardened into what
 * looked like a rendering fault.
 */
describe('columnar scatter sizing is one behaviour, not two', () => {
  // `PointsScatterStyleProps` requires colour and opacity; these tests are about
  // sizing, so they carry the required half without varying it. Test files are outside
  // the build tsconfig's `include`, so omitting them was only an editor error.
  const STYLE = {
    color: [255, 100, 100, 200] as [number, number, number, number],
    opacity: 1,
  };

  const batch = {
    format: 'columnar-ndarray' as const,
    shape: [2, 3],
    data: [new Float32Array([0, 1, 2]), new Float32Array([0, 1, 2])],
    pointCount: 3,
  };

  it('sizes in world units and folds in the model-matrix scale', () => {
    const layer = renderColumnarScatterLayer('scatter', batch, {
      ...STYLE,
      pointSize: 2,
      modelMatrix: new Matrix4().scale([4, 4, 1]),
    });

    expect(layer.props.radiusUnits).toBe('common');
    expect(layer.props.radiusScale).toBeCloseTo(8, 9);
  });

  it('does not change because the batch came from a tile', () => {
    const common = { ...STYLE, pointSize: 2, modelMatrix: new Matrix4().scale([4, 4, 1]) };
    const plain = renderColumnarScatterLayer('plain', batch, common);
    const tiled = renderColumnarScatterLayer('tiled', batch, {
      ...common,
      tileBounds: [0, 0, 10, 10],
    });

    expect(tiled.props.radiusUnits).toBe(plain.props.radiusUnits);
    expect(tiled.props.radiusScale).toBe(plain.props.radiusScale);
  });
});
