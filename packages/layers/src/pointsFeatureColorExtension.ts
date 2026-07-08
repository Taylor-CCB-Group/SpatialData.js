import { LayerExtension } from '@deck.gl/core';
import type { Layer } from '@deck.gl/core';

/**
 * Colours scatter points by their per-point feature code, entirely on the GPU.
 *
 * The feature code rides along as an instance attribute (`featureCode`, supplied
 * as the binary `getFeatureCode` attribute) and a small vertex-shader hook maps
 * it to a categorical colour, overwriting `vFillColor`. The mapping is
 * procedural (a golden-angle hue from the code) so there is no palette buffer to
 * upload and no CPU colour pass; the code attribute is also the one a future
 * per-code visibility mask will read.
 *
 * The extension is attached to EVERY scatter layer, not just when colour is on.
 * This is load-bearing: deck only calls an extension's `initializeState` when
 * the layer first mounts, so attaching it lazily (when colour is toggled on)
 * would never register the `featureCode` attribute — the sublayer already
 * exists and only updates. Colour is instead gated by the attribute value: with
 * no `getFeatureCode` buffer the attribute reads its `-1` default and the shader
 * leaves the flat fill colour untouched.
 *
 * Two more deck subtleties that cost a debugging session:
 *  - the `in float featureCode` declaration must be in `vs:#decl` (deck does NOT
 *    auto-declare it) and the main hook in a TOP-LEVEL `inject` (a module's own
 *    `inject` does not apply to the host layer here);
 *  - `defaultProps.getFeatureCode` must be declared or deck treats the attribute
 *    as constant and never reads the binary buffer (as DataFilterExtension does).
 *
 * Deliberately the smallest possible deck extension — one attribute, one shader
 * hook — so it is a low-risk first candidate to port to a WebGPU shading model.
 */
export class PointsFeatureColorExtension extends LayerExtension {
  static get componentName(): string {
    return 'PointsFeatureColorExtension';
  }

  static defaultProps = {
    getFeatureCode: { type: 'accessor', value: -1 },
  };

  getShaders(this: Layer, extension: this) {
    return {
      ...super.getShaders(extension),
      inject: {
        'vs:#decl': /* glsl */ `
          in float featureCode;

          vec3 pfc_hsv2rgb(vec3 c) {
            vec3 p = abs(fract(c.xxx + vec3(0.0, 2.0 / 3.0, 1.0 / 3.0)) * 6.0 - 3.0);
            return c.z * mix(vec3(1.0), clamp(p - 1.0, 0.0, 1.0), c.y);
          }

          // Golden-angle hue spreads adjacent codes to well-separated colours.
          vec3 pfc_codeToColor(float code) {
            float hue = fract(code * 0.6180339887498949);
            return pfc_hsv2rgb(vec3(hue, 0.72, 0.96));
          }
        `,
        'vs:#main-end': /* glsl */ `
          if (featureCode >= 0.0) {
            vFillColor = vec4(pfc_codeToColor(featureCode), vFillColor.a);
          }
        `,
      },
    };
  }

  initializeState(this: Layer): void {
    const attributeManager = this.getAttributeManager();
    attributeManager?.add({
      featureCode: {
        size: 1,
        type: 'float32',
        stepMode: 'dynamic',
        accessor: 'getFeatureCode',
        defaultValue: -1,
      },
    });
  }
}
