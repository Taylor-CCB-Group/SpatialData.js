/**
 * Colour-by-feature palette constants — the SINGLE SOURCE for both this JS mirror
 * (feature-list swatches) and the GPU shader. The shader
 * (`./pointsFeatureColorExtension.ts`) interpolates these same values into its
 * GLSL so the two can't drift; the OKLab→sRGB matrices and gamma below also match
 * `pfc_oklab2rgb`. A negative code (the "no colour" sentinel) returns grey.
 *
 * Chroma note: sRGB can only hold OKLCh chroma up to ~0.32 (hue-dependent), so at
 * this fixed C most hues are out of gamut and get hard-clamped to the sRGB
 * boundary here and in the shader — vivid, at the cost of some hue accuracy and
 * of the perceptual evenness the boundary erases. Lower C (~0.2–0.3) trades
 * vividness for more in-gamut, even hues; raising C past ~0.32 changes little
 * (already clamped). Kept in lockstep so a tweak here re-colours points too.
 *
 * TODO (revisit): CSS supports `oklch()`/`oklab()` directly, so the swatch could
 * skip this CPU RGB conversion — but only once the shader gamut-maps the same way
 * the browser does (today both hard-clamp here / the browser reduces chroma), or
 * swatches and points would diverge at high C. See the library-wide colour story.
 */
export const PFC_GOLDEN_RATIO_CONJUGATE = 0.6180339887498949;
export const PFC_LIGHTNESS = 0.72;
export const PFC_CHROMA = 0.32;
const TWO_PI = 6.283185307179586;

function fract(x: number): number {
  return x - Math.floor(x);
}

function linearToSrgb(x: number): number {
  return x <= 0.0031308 ? x * 12.92 : 1.055 * Math.max(x, 0) ** (1 / 2.4) - 0.055;
}

function channel255(x: number): number {
  return Math.round(Math.max(0, Math.min(1, x)) * 255);
}

/** OKLab (L, a, b) → sRGB `[r, g, b]` in 0–255 — matches `pfc_oklab2rgb`. */
function oklabToRgb255(L: number, a: number, b: number): [number, number, number] {
  const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = L - 0.0894841775 * a - 1.291485548 * b;
  const l = l_ * l_ * l_;
  const m = m_ * m_ * m_;
  const s = s_ * s_ * s_;
  const r = 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s;
  const g = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s;
  const bl = -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s;
  return [channel255(linearToSrgb(r)), channel255(linearToSrgb(g)), channel255(linearToSrgb(bl))];
}

/** Categorical colour for a feature code as `[r, g, b]` in 0–255. */
export function featureCodeToRgb(code: number): [number, number, number] {
  if (!(code >= 0)) {
    return [128, 128, 128];
  }
  const h = fract(code * PFC_GOLDEN_RATIO_CONJUGATE) * TWO_PI;
  return oklabToRgb255(PFC_LIGHTNESS, PFC_CHROMA * Math.cos(h), PFC_CHROMA * Math.sin(h));
}

/** Same colour as a CSS `rgb(...)` string. */
export function featureCodeToCssColor(code: number): string {
  const [r, g, b] = featureCodeToRgb(code);
  return `rgb(${r}, ${g}, ${b})`;
}
