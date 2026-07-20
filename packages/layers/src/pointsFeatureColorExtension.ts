import type { Layer, UpdateParameters } from '@deck.gl/core';
import { LayerExtension } from '@deck.gl/core';
import {
  buildFeaturePalette,
  type FeatureColorOverrides,
  featurePaletteWidth,
} from './pointsFeatureColor.js';

/** A luma texture, narrowed to the members this extension touches. */
interface PaletteTexture {
  width: number;
  destroy?: () => void;
  delete?: () => void;
}

interface DeviceLike {
  createTexture(descriptor: Record<string, unknown>): PaletteTexture;
}

/**
 * Uniform block for the colour pass:
 *  - `highlightCode`: the emphasised feature code + 1 (0 = no highlight; also what a
 *    zeroed UBO reads, so the default is safe even if the binding fails — code 0 would
 *    otherwise be a valid, wrongly-highlighted value).
 *  - `paletteWidth`: the LUT width, so the shader can clamp an out-of-range code to
 *    the last texel instead of reading undefined memory.
 */
const PFC_COLOR_MODULE = {
  name: 'pfcColor',
  vs: /* glsl */ `
    uniform sampler2D pfcPalette;
    layout(std140) uniform pfcColorUniforms {
      float highlightCode;
      float paletteWidth;
    } pfcColor;
  `,
  uniformTypes: { highlightCode: 'f32' as const, paletteWidth: 'f32' as const },
};

/** Dispose a luma texture across the two method names different versions expose. */
function destroyTexture(texture: PaletteTexture | undefined): void {
  texture?.destroy?.();
  texture?.delete?.();
}

/**
 * Colours scatter points by their per-point feature code, entirely on the GPU.
 *
 * The feature code rides along as an instance attribute (`featureCode`, supplied as
 * the binary `getFeatureCode` attribute); the vertex shader looks the code up in a
 * **palette texture** (`pfcPalette`) — a 1-row RGBA LUT, one texel per code — and
 * writes the result to `vFillColor`. The palette is built on the CPU from
 * {@link buildFeaturePalette} (defaults matching the old procedural golden-angle
 * hue, plus any per-feature overrides), so colour is now DATA, not a hard-coded
 * formula: a feature can be recoloured by patching one texel.
 *
 * Why a texture and not the old inline OKLab math: it makes per-feature override
 * possible at all, gives one source of truth shared with the JS swatches, and keeps
 * the shader trivial (one `texelFetch`). Hover highlight stays a UNIFORM
 * (`highlightCode`), not a palette write — it changes every mousemove, and a uniform
 * is far cheaper than re-uploading a texture per frame.
 *
 * The extension is attached to EVERY scatter layer, not just when colour is on. This
 * is load-bearing: deck only calls an extension's `initializeState` when the layer
 * first mounts, so attaching it lazily (when colour is toggled on) would never
 * register the `featureCode` attribute — the sublayer already exists and only
 * updates. Colour is instead gated by the attribute value: with no `getFeatureCode`
 * buffer the attribute reads its `-1` default and the shader leaves the flat fill
 * colour untouched. A palette texture is ALWAYS bound (a 1×1 fallback until a real
 * one arrives), because a declared sampler with no binding is a draw error.
 *
 * Deck subtleties that each cost a debugging session:
 *  - `in float featureCode` must be declared in `vs:#decl` (deck does NOT auto-declare
 *    it) and the colour hook in a TOP-LEVEL `inject` (a module's own `inject` does not
 *    apply to the host layer here);
 *  - `defaultProps.getFeatureCode` must be declared or deck treats the attribute as
 *    constant and never reads the binary buffer (as DataFilterExtension does);
 *  - the `pfcPalette` sampler is bound with `model.setBindings` (mirroring
 *    `LabelsBitmaskTileLayer`), which is separate from the UBO's `setShaderModuleProps`.
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
    /** Number of feature codes the palette must cover (the catalog's `maxCode + 1`).
     * Sizes the LUT texture. */
    featureCodeSpaceSize: { type: 'number', value: 0 },
    /** Per-feature colour overrides (`code → [r,g,b]`); absent codes keep the default. */
    featureColorOverrides: { type: 'object', value: null as FeatureColorOverrides | null },
  };

  getShaders(this: Layer, extension: this) {
    // The base returns null, and the module list may be absent — guard both.
    const shaders = (super.getShaders(extension) ?? {}) as { modules?: unknown[] };
    return {
      ...shaders,
      modules: [...(shaders.modules ?? []), PFC_COLOR_MODULE],
      inject: {
        'vs:#decl': /* glsl */ `
          in float featureCode;
        `,
        'vs:#main-end': /* glsl */ `
          if (featureCode >= 0.0) {
            // Clamp to the last texel so a code beyond the LUT mis-colours its tail
            // rather than reading undefined texture memory (texelFetch ignores the
            // sampler's clamp-to-edge, unlike texture()).
            int pfcIdx = clamp(int(featureCode + 0.5), 0, int(pfcColor.paletteWidth) - 1);
            vec3 pfcRgb = texelFetch(pfcPalette, ivec2(pfcIdx, 0), 0).rgb;
            // Highlight: uniform holds highlightCode + 1 (0 = off). Non-matching codes
            // are desaturated toward their luminance and dimmed.
            if (pfcColor.highlightCode > 0.5 && abs(featureCode - (pfcColor.highlightCode - 1.0)) > 0.5) {
              float pfcLum = dot(pfcRgb, vec3(0.2126, 0.7152, 0.0722));
              pfcRgb = mix(vec3(pfcLum), pfcRgb, 0.2) * 0.55;
            }
            vFillColor = vec4(pfcRgb, vFillColor.a);
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
    // Build from the ACTUAL props, not a hard-coded 1×1. This sublayer only mounts
    // once there is a batch to draw, by which time the catalog is often already
    // loaded — so `featureCodeSpaceSize` arrives at its final value here and never
    // "changes" again. Seeding a 1×1 and waiting for a change left the palette one
    // texel wide forever, and the shader clamps every code to texel 0: one flat
    // colour for the whole layer. (`buildFeaturePalette` floors width at 1, so an
    // unknown code space still yields a bindable fallback.)
    const props = this.props as {
      featureCodeSpaceSize?: number;
      featureColorOverrides?: FeatureColorOverrides | null;
    };
    pfcSetPaletteTexture(
      this,
      pfcBuildPaletteTexture(
        this,
        props.featureCodeSpaceSize ?? 0,
        props.featureColorOverrides ?? null
      )
    );
  }

  updateState(this: Layer, params: UpdateParameters<Layer>): void {
    const props = params.props as {
      featureCodeSpaceSize?: number;
      featureColorOverrides?: FeatureColorOverrides | null;
    };
    const oldProps = params.oldProps as typeof props;
    const state = this.state as { pfcPaletteTexture?: PaletteTexture };
    // Reconcile against the texture we actually hold rather than against a prop
    // transition: a width mismatch means the palette cannot colour every code, no
    // matter which update did or didn't fire. Self-healing, so a missed transition
    // degrades to a rebuild instead of a permanently wrong palette.
    const neededWidth = featurePaletteWidth(props.featureCodeSpaceSize ?? 0);
    if (
      state.pfcPaletteTexture?.width !== neededWidth ||
      props.featureColorOverrides !== oldProps.featureColorOverrides
    ) {
      pfcSetPaletteTexture(
        this,
        pfcBuildPaletteTexture(
          this,
          props.featureCodeSpaceSize ?? 0,
          props.featureColorOverrides ?? null
        )
      );
    }
  }

  draw(this: Layer): void {
    const props = this.props as { highlightFeatureCode?: number };
    const state = this.state as { pfcPaletteTexture?: PaletteTexture; model?: unknown };
    const highlight = props.highlightFeatureCode ?? -1;
    const texture = state.pfcPaletteTexture;
    // Store code + 1 so "no highlight" is 0 (safe default; see PFC_COLOR_MODULE).
    (this as unknown as { setShaderModuleProps(props: unknown): void }).setShaderModuleProps({
      pfcColor: {
        highlightCode: highlight >= 0 ? highlight + 1 : 0,
        paletteWidth: texture?.width ?? 1,
      },
    });
    if (texture) {
      (
        state.model as { setBindings?: (b: Record<string, unknown>) => void } | undefined
      )?.setBindings?.({ pfcPalette: texture });
    }
  }

  finalizeState(this: Layer): void {
    const state = this.state as { pfcPaletteTexture?: PaletteTexture };
    destroyTexture(state.pfcPaletteTexture);
    state.pfcPaletteTexture = undefined;
  }
}

/** Create the LUT texture for a code space (+ overrides). Falls back to a 1×1 texel
 * when the code space isn't known yet, so a texture is always available to bind. */
function pfcBuildPaletteTexture(
  layer: Layer,
  codeSpaceSize: number,
  overrides: FeatureColorOverrides | null
): PaletteTexture | undefined {
  const device = (layer.context as { device?: DeviceLike } | undefined)?.device;
  if (!device) {
    return undefined;
  }
  const palette = buildFeaturePalette(codeSpaceSize, overrides ?? undefined);
  return device.createTexture({
    width: palette.width,
    height: 1,
    dimension: '2d',
    data: palette.data,
    mipmaps: false,
    format: 'rgba8unorm',
    sampler: {
      minFilter: 'nearest',
      magFilter: 'nearest',
      addressModeU: 'clamp-to-edge',
      addressModeV: 'clamp-to-edge',
    },
  });
}

/** Swap the layer's palette texture, disposing the previous one. */
function pfcSetPaletteTexture(layer: Layer, texture: PaletteTexture | undefined): void {
  const state = layer.state as { pfcPaletteTexture?: PaletteTexture };
  if (state.pfcPaletteTexture === texture) {
    return;
  }
  destroyTexture(state.pfcPaletteTexture);
  state.pfcPaletteTexture = texture;
}
