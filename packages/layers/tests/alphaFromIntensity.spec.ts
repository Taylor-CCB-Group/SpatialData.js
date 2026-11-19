import { type Layer, LayerExtension } from '@deck.gl/core';
import { ScatterplotLayer } from '@deck.gl/layers';
import { describe, expect, it } from 'vitest';
import { AlphaFromIntensityExtension, resolveAlphaFromIntensity } from '../src/alphaFromIntensity';
import { DeviceAdaptiveImageLayer } from '../src/webgpu/deviceAdaptiveImageLayer';

describe('resolveAlphaFromIntensity', () => {
  it('is off unless given an object, and fills in defaults', () => {
    expect(resolveAlphaFromIntensity(undefined)).toBeNull();
    expect(resolveAlphaFromIntensity(true)).toBeNull();
    expect(resolveAlphaFromIntensity({})).toEqual({ threshold: 0, gain: 1 });
    expect(resolveAlphaFromIntensity({ threshold: 0.2, gain: 'x' })).toEqual({
      threshold: 0.2,
      gain: 1,
    });
  });
});

/** Stands in for a Viv image layer: only its props and `clone` are read on WebGL. */
function vivLikeLayer(extraProps: Record<string, unknown>): Layer {
  return new ScatterplotLayer({ id: 'viv', data: [], ...extraProps });
}

function renderOnWebGL(vivLayer: Layer): Layer {
  const layer = new DeviceAdaptiveImageLayer({ id: 'device', vivLayer });
  // renderLayers only reads the device type from the context.
  Object.assign(layer, { context: { device: { type: 'webgl' } } });
  return layer.renderLayers();
}

function alphaExtensions(layer: Layer) {
  return layer.props.extensions.filter((e) => e instanceof AlphaFromIntensityExtension);
}

describe('DeviceAdaptiveImageLayer on WebGL', () => {
  it('keeps the Viv layer\'s own extensions without the option', () => {
    const colour = new (class ColourExtension extends LayerExtension {})();
    const vivLayer = vivLikeLayer({ extensions: [colour] });
    expect(renderOnWebGL(vivLayer).props.extensions).toEqual([colour]);
  });

  it('adds the extension once, after the existing ones, with a stable instance', () => {
    const colour = new (class ColourExtension extends LayerExtension {})();
    const vivLayer = vivLikeLayer({ alphaFromIntensity: { gain: 2 }, extensions: [colour] });
    const first = renderOnWebGL(vivLayer);
    const second = renderOnWebGL(vivLayer);

    expect(first.props.extensions[0]).toBe(colour);
    expect(alphaExtensions(first)).toHaveLength(1);
    expect(first.props.extensions[1]).toBe(alphaExtensions(first)[0]);
    expect(second.props.extensions[1]).toBe(first.props.extensions[1]);
    expect(alphaExtensions(renderOnWebGL(first))).toHaveLength(1);
  });

  // Viv's background image and overlapping parent tiles showed through the transparent pixels.
  it('draws no background or overlapping tiles under a translucent image', () => {
    const plain = renderOnWebGL(vivLikeLayer({})).props;
    expect(plain).not.toHaveProperty('excludeBackground');

    const props = renderOnWebGL(vivLikeLayer({ alphaFromIntensity: {} })).props;
    expect(props).toMatchObject({ excludeBackground: true, refinementStrategy: 'no-overlap' });
  });
});
