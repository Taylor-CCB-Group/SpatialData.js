import { describe, expect, it } from 'vitest';
import { featureCodeToRgb } from '../src/pointsFeatureColor.js';
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
    // Row-major 2-D lookup, sized from the bound texture itself.
    expect(mainEnd).toContain('textureSize(pfcPalette, 0)');
    expect(mainEnd).toContain(
      'texelFetch(pfcPalette, ivec2(pfcIdx % pfcSize.x, pfcIdx / pfcSize.x), 0)'
    );
    const paletteModule = (shaders.modules as Array<{ name: string; vs: string }>).find(
      (m) => m.name === 'pfcColor'
    );
    expect(paletteModule?.vs).toContain('sampler2D pfcPalette');
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

describe('PointsFeatureColorExtension palette texture', () => {
  interface Descriptor {
    width: number;
    height: number;
    data: Uint8Array;
  }

  // Stands in for the host layer: records every texture the extension creates.
  function mountHost(props: Record<string, unknown>) {
    const created: Array<Descriptor & { destroyed: boolean }> = [];
    const device = {
      createTexture(descriptor: Descriptor) {
        const texture = { ...descriptor, destroyed: false, destroy: () => {} };
        texture.destroy = () => {
          texture.destroyed = true;
        };
        created.push(texture);
        return texture;
      },
    };
    const host = {
      props,
      state: {} as Record<string, unknown>,
      context: { device },
      getAttributeManager: () => ({ add: () => {} }),
    };
    const ext = new PointsFeatureColorExtension();
    ext.initializeState.call(host as never);
    const update = (next: Record<string, unknown>) => {
      const oldProps = host.props;
      host.props = next;
      ext.updateState.call(host as never, { props: next, oldProps } as never);
    };
    return { created, update };
  }

  it('colours a code past 16,384 from a texture no dimension of which exceeds 4096', () => {
    const { created } = mountHost({ featureCodeSpaceSize: 24_674 });
    expect(created).toHaveLength(1);
    const [texture] = created;
    expect(texture.width).toBeLessThanOrEqual(4096);
    expect(texture.height).toBeLessThanOrEqual(4096);

    // Mirrors the shader's lookup: texel (code % width, code / width), row-major.
    const code = 24_000;
    const x = code % texture.width;
    const y = Math.floor(code / texture.width);
    const o = (y * texture.width + x) * 4;
    expect([...texture.data.slice(o, o + 3)]).toEqual(featureCodeToRgb(code));
  });

  it('keeps the texture across cosmetic updates and rebuilds once when the code space grows', () => {
    const { created, update } = mountHost({ featureCodeSpaceSize: 0 });
    update({ featureCodeSpaceSize: 0, highlightFeatureCode: 3 });
    update({ featureCodeSpaceSize: 4096, highlightFeatureCode: 5 });
    expect(created).toHaveLength(1);

    update({ featureCodeSpaceSize: 24_674 });
    update({ featureCodeSpaceSize: 24_674, highlightFeatureCode: 7 });
    expect(created).toHaveLength(2);
    expect(created[0].destroyed).toBe(true);
    expect(created[1].destroyed).toBe(false);
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
    expect(source).toContain(
      'textureLoad(pfcPalette, vec2<i32>(pfcIdx % pfcSize.x, pfcIdx / pfcSize.x), 0)'
    );
  });

  it('refuses a scatterplot WGSL without the anchors', () => {
    expect(() => injectPointsFeatureColorWGSL('fn vertexMain() {}')).toThrow(/anchors/);
  });
});
