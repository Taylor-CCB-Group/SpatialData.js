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

/** Per-feature colour overrides: `code → [r, g, b]` (0–255). Any code absent here
 * keeps its default {@link featureCodeToRgb} colour. */
export type FeatureColorOverrides = ReadonlyMap<number, readonly [number, number, number]>;

/**
 * Default LUT width, used whenever the catalog is unknown or smaller.
 *
 * The colour of a code is a PURE FUNCTION of that code — the catalog is not an input.
 * Sizing the table from the catalog was a design error with a very visible cost: the
 * catalog is the LAST thing to load on a big element, so until it landed the palette
 * was one texel wide and the shader clamped every code to texel 0 — the whole layer
 * one flat colour for the entire load. Covering a generous code space up front makes
 * colour correct from the first streamed chunk; the width only grows if a catalog
 * turns out to be bigger. 4096 texels is 16 KB.
 */
export const DEFAULT_FEATURE_PALETTE_WIDTH = 4096;

/** The LUT width for a (possibly unknown) code space. Callers that compare against an
 * existing texture must use this, so "needed" and "built" agree. */
export function featurePaletteWidth(codeSpaceSize: number): number {
  const requested = Number.isFinite(codeSpaceSize) ? Math.floor(codeSpaceSize) : 0;
  return Math.max(DEFAULT_FEATURE_PALETTE_WIDTH, requested);
}

/** A colour lookup table indexed by feature code — one RGBA texel per code. Uploaded
 * to a GPU texture and sampled by {@link pointsFeatureColorExtension} with
 * `texelFetch(pfcPalette, ivec2(code, 0), 0)`. */
export interface FeaturePalette {
  /** RGBA8, row-major: bytes `[4*code .. 4*code+3]` are the colour for `code`. */
  data: Uint8Array;
  /** Texture width = number of codes covered (`maxCode + 1`). Always ≥ 1. */
  width: number;
}

/**
 * Build the feature-colour lookup table. Texel `i` is the colour for code `i`:
 * {@link featureCodeToRgb} by default (so the palette is byte-identical to the
 * procedural shader it replaced), with `overrides` patching individual codes.
 *
 * `codeSpaceSize` is a LOWER bound, not the answer: the table is always at least
 * {@link DEFAULT_FEATURE_PALETTE_WIDTH} wide so colour works before any catalog
 * loads. A code beyond the table is clamped to the last texel by the shader, so an
 * under-sized table mis-colours the tail rather than crashing.
 */
export function buildFeaturePalette(
  codeSpaceSize: number,
  overrides?: FeatureColorOverrides
): FeaturePalette {
  const width = featurePaletteWidth(codeSpaceSize);
  const data = new Uint8Array(width * 4);
  for (let code = 0; code < width; code += 1) {
    const [r, g, b] = overrides?.get(code) ?? featureCodeToRgb(code);
    const offset = code * 4;
    data[offset] = r;
    data[offset + 1] = g;
    data[offset + 2] = b;
    data[offset + 3] = 255;
  }
  return { data, width };
}
