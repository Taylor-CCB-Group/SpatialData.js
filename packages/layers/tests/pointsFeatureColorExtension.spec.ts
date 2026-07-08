import { describe, expect, it } from 'vitest';
import { PointsFeatureColorExtension } from '../src/pointsFeatureColorExtension.js';

// These assert the deck-specific invariants that were load-bearing and easy to
// get subtly wrong (each cost real debugging). They guard the shader wiring, not
// GPU output — the rendered colour is verified live in the demo.
describe('PointsFeatureColorExtension', () => {
  const ext = new PointsFeatureColorExtension();
  // getShaders reads `this` only for super.getShaders(); a bare object with a
  // no-op getShaders stands in for the host layer.
  const shaders = ext.getShaders.call({ getShaders: () => ({}) } as never, ext);

  it('declares getFeatureCode as an accessor in defaultProps', () => {
    // Without this, deck treats the attribute as constant and never reads the
    // binary buffer supplied via data.attributes.
    expect(PointsFeatureColorExtension.defaultProps.getFeatureCode).toEqual({
      type: 'accessor',
      value: -1,
    });
  });

  it('declares `in float featureCode` in a top-level vs:#decl inject', () => {
    // deck does not auto-declare the attribute; the declaration must be in
    // vs:#decl (NOT a module) or the whole hook silently drops.
    expect(shaders.inject['vs:#decl']).toContain('in float featureCode;');
    expect(shaders.inject).not.toHaveProperty('modules');
  });

  it('recolours vFillColor only for a non-negative code in vs:#main-end', () => {
    // The -1 default gates colour off (flat fill) without a uniform.
    const mainEnd = shaders.inject['vs:#main-end'];
    expect(mainEnd).toContain('featureCode >= 0.0');
    expect(mainEnd).toContain('vFillColor');
  });
});
