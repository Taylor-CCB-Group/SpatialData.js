import { LayerExtension } from '@deck.gl/core';
import type { Layer } from '@deck.gl/core';
import { PFC_CHROMA, PFC_GOLDEN_RATIO_CONJUGATE, PFC_LIGHTNESS } from './pointsFeatureColor.js';

/** Render a JS number as a GLSL float literal (always with a decimal point, so an
 * integer-valued constant doesn't become an `int` in the shader). Lets the shader
 * interpolate the SAME palette constants the JS swatch mirror uses. */
function glslFloat(value: number): string {
  const text = String(value);
  return text.includes('.') || text.includes('e') ? text : `${text}.0`;
}

/**
 * Uniform block for the highlight. The stored value is `highlightCode + 1`, so
 * the "no highlight" state is 0 — which is also what an unbound/zeroed UBO
 * reads, making the default safe even if the binding ever fails (feature code 0
 * would otherwise be a valid, and wrongly-highlighted, value).
 */
const PFC_HIGHLIGHT_MODULE = {
  name: 'pfcHighlight',
  vs: /* glsl */ `
    layout(std140) uniform pfcHighlightUniforms {
      float code;
    } pfcHighlight;
  `,
  uniformTypes: { code: 'f32' as const },
};

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
    /** Emphasize one feature code: points of other codes are desaturated + dimmed
     * while this is >= 0. -1 (default) highlights nothing. */
    highlightFeatureCode: { type: 'number', value: -1 },
  };

  getShaders(this: Layer, extension: this) {
    // The base returns null, and the module list may be absent — guard both.
    const shaders = (super.getShaders(extension) ?? {}) as { modules?: unknown[] };
    return {
      ...shaders,
      modules: [...(shaders.modules ?? []), PFC_HIGHLIGHT_MODULE],
      inject: {
        'vs:#decl': /* glsl */ `
          in float featureCode;

          // OKLab → linear sRGB → gamma sRGB. OKLab spaces hues perceptually
          // evenly, so a golden-angle sweep of its hue gives adjacent codes
          // colours that look as distinct as they are numerically (unlike HSV,
          // where big hue arcs — the greens — read as one colour). Out-of-gamut
          // (L,C) combinations are clamped rather than gamut-mapped; fine for
          // categorical swatches at a fixed moderate chroma.
          vec3 pfc_oklab2rgb(vec3 lab) {
            float l_ = lab.x + 0.3963377774 * lab.y + 0.2158037573 * lab.z;
            float m_ = lab.x - 0.1055613458 * lab.y - 0.0638541728 * lab.z;
            float s_ = lab.x - 0.0894841775 * lab.y - 1.2914855480 * lab.z;
            vec3 lms = vec3(l_ * l_ * l_, m_ * m_ * m_, s_ * s_ * s_);
            vec3 rgb = vec3(
               4.0767416621 * lms.x - 3.3077115913 * lms.y + 0.2309699292 * lms.z,
              -1.2684380046 * lms.x + 2.6097574011 * lms.y - 0.3413193965 * lms.z,
              -0.0041960863 * lms.x - 0.7034186147 * lms.y + 1.7076147010 * lms.z
            );
            vec3 low = rgb * 12.92;
            vec3 high = 1.055 * pow(max(rgb, 0.0), vec3(1.0 / 2.4)) - 0.055;
            return clamp(mix(high, low, step(rgb, vec3(0.0031308))), 0.0, 1.0);
          }

          // Golden-angle hue in OKLCh at a fixed lightness/chroma. The lightness,
          // chroma and golden-ratio constants come from pointsFeatureColor.ts so
          // the swatches and the GPU points share one source (tweak them there).
          vec3 pfc_codeToColor(float code) {
            float h = fract(code * ${glslFloat(PFC_GOLDEN_RATIO_CONJUGATE)}) * 6.28318530717958648;
            return pfc_oklab2rgb(vec3(
              ${glslFloat(PFC_LIGHTNESS)},
              ${glslFloat(PFC_CHROMA)} * cos(h),
              ${glslFloat(PFC_CHROMA)} * sin(h)
            ));
          }
        `,
        'vs:#main-end': /* glsl */ `
          if (featureCode >= 0.0) {
            vec3 pfcColor = pfc_codeToColor(featureCode);
            // Highlight: uniform holds highlightCode + 1 (0 = off). Non-matching
            // codes are desaturated toward their luminance and dimmed.
            if (pfcHighlight.code > 0.5 && abs(featureCode - (pfcHighlight.code - 1.0)) > 0.5) {
              float pfcLum = dot(pfcColor, vec3(0.2126, 0.7152, 0.0722));
              pfcColor = mix(vec3(pfcLum), pfcColor, 0.2) * 0.55;
            }
            vFillColor = vec4(pfcColor, vFillColor.a);
          }
        `,
      },
    };
  }

  draw(this: Layer): void {
    const highlight = (this.props as { highlightFeatureCode?: number }).highlightFeatureCode ?? -1;
    // Store code + 1 so "no highlight" is 0 (safe default; see PFC_HIGHLIGHT_MODULE).
    (this as unknown as { setShaderModuleProps(props: unknown): void }).setShaderModuleProps({
      pfcHighlight: { code: highlight >= 0 ? highlight + 1 : 0 },
    });
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
