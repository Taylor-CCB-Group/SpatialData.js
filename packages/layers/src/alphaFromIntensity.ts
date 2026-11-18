import { type Layer, LayerExtension } from '@deck.gl/core';

/**
 * Opacity from brightness, for drawing a dark-background image (fluorescence, IMC)
 * over another (brightfield). With `b` the brightest of R, G and B after the channel
 * colour mix, the pixel's alpha is scaled by `a = clamp((b - threshold) * gain, 0, 1)`
 * and its colour divided by `max(a, b)`. Where `a >= b` the image over black looks as it
 * did without the option; a low threshold with a high gain is close to a binary cut,
 * hiding near-black and leaving the rest as it was.
 */
export type AlphaFromIntensity = {
  /** Brightness (0-1) at or below which the image is fully transparent. Default 0. */
  threshold?: number;
  /** How fast opacity rises above the threshold. Default 1. */
  gain?: number;
};

export type ResolvedAlphaFromIntensity = Required<AlphaFromIntensity>;

function finiteOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/** Reads the option from untyped layer props or saved config; null when it is off. */
export function resolveAlphaFromIntensity(value: unknown): ResolvedAlphaFromIntensity | null {
  if (typeof value !== 'object' || value === null) {
    return null;
  }
  const threshold = 'threshold' in value ? value.threshold : undefined;
  const gain = 'gain' in value ? value.gain : undefined;
  return { threshold: finiteOr(threshold, 0), gain: finiteOr(gain, 1) };
}

const alphaFromIntensityModule = {
  name: 'alphaFromIntensity',
  uniformTypes: { threshold: 'f32', gain: 'f32' },
  fs: /* glsl */ `\
uniform alphaFromIntensityUniforms {
  float threshold;
  float gain;
} alphaFromIntensity;
`,
  inject: {
    // Discards where fully transparent, as the WGSL path does, so those pixels don't pick.
    'fs:DECKGL_FILTER_COLOR': /* glsl */ `
  float alphaBrightness = max(max(color.r, color.g), color.b);
  float alphaScale = clamp(
    (alphaBrightness - alphaFromIntensity.threshold) * alphaFromIntensity.gain, 0.0, 1.0
  );
  if (alphaScale <= 0.0) {
    discard;
  }
  color.rgb /= max(max(alphaScale, alphaBrightness), 1e-6);
  color.a *= alphaScale;
`,
  },
} as const;

type AlphaFromIntensityLayerProps = { alphaFromIntensity?: unknown };

/**
 * GLSL side of {@link AlphaFromIntensity}, for Viv's XRLayer on WebGL. It reads the
 * `alphaFromIntensity` layer prop; the WGSL `RasterTileLayer` has the same maths built in.
 */
export class AlphaFromIntensityExtension extends LayerExtension {
  static extensionName = 'AlphaFromIntensityExtension';

  getShaders() {
    return { modules: [alphaFromIntensityModule] };
  }

  draw(this: Layer<AlphaFromIntensityLayerProps>) {
    const resolved = resolveAlphaFromIntensity(this.props.alphaFromIntensity) ?? {
      threshold: 0,
      gain: 1,
    };
    for (const model of this.getModels()) {
      model.shaderInputs.setProps({ alphaFromIntensity: resolved });
    }
  }
}

/** One shared instance, so deck sees the same extension list across renders. */
export const alphaFromIntensityExtension = new AlphaFromIntensityExtension();
