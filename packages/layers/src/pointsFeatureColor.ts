/**
 * JS mirror of the colour-by-feature shader in {@link ./pointsFeatureColorExtension.ts}.
 *
 * MUST stay in lockstep with `pfc_codeToColor` / `pfc_hsv2rgb` there so the
 * feature-list swatches match what the GPU draws. Same golden-angle hue, same
 * HSV(0.72, 0.96). A negative code (the "no colour" sentinel) returns grey.
 */
const PFC_GOLDEN_RATIO_CONJUGATE = 0.6180339887498949;
const PFC_SATURATION = 0.72;
const PFC_VALUE = 0.96;

function fract(x: number): number {
  return x - Math.floor(x);
}

function hsvChannel(hue: number, offset: number, s: number, v: number): number {
  const p = Math.abs(fract(hue + offset) * 6 - 3);
  const mixed = 1 + (Math.max(0, Math.min(1, p - 1)) - 1) * s;
  return Math.round(v * mixed * 255);
}

/** Categorical colour for a feature code as `[r, g, b]` in 0–255. */
export function featureCodeToRgb(code: number): [number, number, number] {
  if (!(code >= 0)) {
    return [128, 128, 128];
  }
  const hue = fract(code * PFC_GOLDEN_RATIO_CONJUGATE);
  return [
    hsvChannel(hue, 0, PFC_SATURATION, PFC_VALUE),
    hsvChannel(hue, 2 / 3, PFC_SATURATION, PFC_VALUE),
    hsvChannel(hue, 1 / 3, PFC_SATURATION, PFC_VALUE),
  ];
}

/** Same colour as a CSS `rgb(...)` string. */
export function featureCodeToCssColor(code: number): string {
  const [r, g, b] = featureCodeToRgb(code);
  return `rgb(${r}, ${g}, ${b})`;
}
