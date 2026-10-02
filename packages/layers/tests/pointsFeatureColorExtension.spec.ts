import { describe, expect, it } from 'vitest';
import {
  injectPointsFeatureColorWGSL,
  PointsFeatureColorExtension,
} from '../src/pointsFeatureColorExtension.js';
import { PointsScatterplotLayer } from '../src/pointsScatterLayer.js';

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

  it('samples the colour from the pfcPalette LUT (not a procedural formula)', () => {
    const mainEnd = shaders.inject['vs:#main-end'];
    expect(mainEnd).toContain('texelFetch(pfcPalette');
    // The palette module must declare the sampler + the width used to clamp the index.
    const paletteModule = (shaders.modules as Array<{ name: string; vs: string }>).find(
      (m) => m.name === 'pfcColor'
    );
    expect(paletteModule?.vs).toContain('sampler2D pfcPalette');
    expect(paletteModule?.vs).toContain('paletteWidth');
  });

  it('declares the LUT-sizing and override props so deck tracks them', () => {
    // Without these on the extension's defaultProps, deck would not diff them and the
    // texture would never rebuild when the code space or overrides change.
    expect(PointsFeatureColorExtension.defaultProps.featureCodeSpaceSize).toEqual({
      type: 'number',
      value: 0,
    });
    expect(PointsFeatureColorExtension.defaultProps.featureColorOverrides).toMatchObject({
      type: 'object',
    });
  });

  it('adds no GLSL injections on WebGPU, only the WGSL uniforms + palette', () => {
    // GLSL text spliced into WGSL would fail to compile; on WebGPU the colour code
    // goes in through PointsScatterplotLayer instead.
    const host = { getShaders: () => ({}), context: { device: { type: 'webgpu' } } };
    const webgpu = ext.getShaders.call(host as never, ext) as {
      inject?: unknown;
      modules: Array<{ name: string; source?: string }>;
    };
    expect(webgpu.inject).toBeUndefined();
    const paletteModule = webgpu.modules.find((module) => module.name === 'pfcColor');
    expect(paletteModule?.source).toContain('var pfcPalette: texture_2d<f32>');
  });
});

describe('PointsScatterplotLayer WGSL', () => {
  it("finds its injection anchors in the installed deck's scatterplot WGSL", () => {
    // Pins the deck version: an upgrade that reshapes the shader throws here rather
    // than drawing every point in the flat colour.
    // getShaders reads only the device type and deck's default modules before mount.
    const layer = Object.assign(new PointsScatterplotLayer({ id: 'probe', data: [] }), {
      context: { device: { type: 'webgpu' }, defaultShaderModules: [] },
    });
    const source: string = layer.getShaders().source;
    expect(source).toContain('@location(9) featureCode: f32,');
    expect(source).toContain('textureLoad(pfcPalette');
  });

  it('refuses a scatterplot WGSL without the anchors', () => {
    expect(() => injectPointsFeatureColorWGSL('fn vertexMain() {}')).toThrow(/anchors/);
  });
});
