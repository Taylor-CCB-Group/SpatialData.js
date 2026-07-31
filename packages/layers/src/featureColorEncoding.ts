/**
 * Table column → per-feature colour, shared by every annotated element kind.
 *
 * The encoding question — "given one table column, what colour is each feature?" —
 * is identical for shapes and for labels. Only the *addressing* differs: a shape is
 * addressed by its feature index (a position in the geometry buffers), a label by
 * its integer instance id (the raster's pixel value). So the palette, the numeric
 * ramp, the auto-detect rule and the category assignment order all live here, and
 * each kind's module owns nothing but its own addressing.
 *
 * `shapeColorEncoding` and `labelColorEncoding` are both thin wrappers over
 * {@link assignFeatureColors}; keeping the rule in one place is what makes "the same
 * column, coloured the same way" true across a shapes layer and a labels layer drawn
 * over the same table.
 */

import { featureCodeToRgb } from './pointsFeatureColor';

export type FeatureFillColorMode = 'auto' | 'categorical' | 'continuous';

export type FeatureRgbColor = [number, number, number];
export type FeatureRgbaColor = [number, number, number, number];

/**
 * Precomputed per-feature colours — the currency both kinds render from, and the
 * one a host can hand us directly instead of a `featureId → colour` dictionary.
 *
 * The dictionary form is fine for a handful of overrides and wrong for a whole
 * element: it stringifies integers the caller already had, then costs a Map copy
 * and (for labels) a parse per entry, all to end up here. A host driving colour
 * from its own data — a computed column, an external annotation, a live selection
 * — should write these bytes once and hand them over.
 *
 * **What the index means differs by kind, and it matters:**
 *  - labels — the raster's own pixel value (the label's instance id). Stable and
 *    data-defined; a host can author this from the table alone.
 *  - shapes — the feature's position in the loaded geometry, which is decided by
 *    the loader, not the data. A host must build against the `featureIds` ordering
 *    it is given, never one it assumes.
 *
 * Alpha is a MODULATION, not an opacity: `0` hides the feature, and anything else
 * scales what the layer would otherwise draw at. Bake filtering into it.
 */
export interface FeatureColorBuffer {
  /** RGBA, row-major: bytes `[4*i .. 4*i+3]` are the colour for index `i`. */
  colors: Uint8Array;
  /** Number of indices covered. An index at or beyond this is unannotated. */
  count: number;
}

/** Read one RGBA out of a buffer; `undefined` when the index is not covered. */
export function featureColorAt(
  buffer: FeatureColorBuffer | undefined,
  index: number
): FeatureRgbaColor | undefined {
  if (!buffer || !Number.isInteger(index) || index < 0 || index >= buffer.count) {
    return undefined;
  }
  const offset = index * 4;
  return [
    buffer.colors[offset],
    buffer.colors[offset + 1],
    buffer.colors[offset + 2],
    buffer.colors[offset + 3],
  ];
}

/**
 * How to colour categories. JSON-serializable on purpose — this travels in a saved
 * layer config, so it is a name or a plain list of colours, never a function.
 *
 *  - `'oklab'` — the points colour-by-feature scheme: OKLCh at fixed lightness and
 *               chroma, hue stepped by the golden angle. **Unbounded** — every
 *               category index gets its own well-separated hue, so a 30-category
 *               annotation does not repeat colours. The default.
 *  - a list    — your own colours, cycled. An empty list falls back to `'oklab'`
 *               rather than colouring nothing.
 */
export type FeatureCategoricalPaletteSpec = 'oklab' | readonly FeatureRgbColor[];

export type FeatureNumericRampSpec = readonly [FeatureRgbColor, FeatureRgbColor];

export const DEFAULT_FEATURE_CATEGORICAL_PALETTE: FeatureCategoricalPaletteSpec = 'oklab';

export const DEFAULT_FEATURE_NUMERIC_RAMP: FeatureNumericRampSpec = [
  [0, 64, 255],
  [255, 220, 0],
];

/**
 * Turn a palette spec into `categoryIndex → colour`.
 *
 * A function rather than an array because `'oklab'` has no length: its colour is a
 * pure function of the index, so there is no table to run out of. That is the whole
 * point of making it the default — the cycling of a fixed list is invisible in the
 * render (two cell types simply share a colour) and so is exactly the kind of bug
 * that survives review.
 */
export function resolveCategoricalPalette(
  spec: FeatureCategoricalPaletteSpec = DEFAULT_FEATURE_CATEGORICAL_PALETTE
): (categoryIndex: number) => FeatureRgbColor {
  if (spec === 'oklab') {
    return featureCodeToRgb;
  }
  const colors = spec;
  if (colors.length === 0) {
    return featureCodeToRgb;
  }
  return (categoryIndex) => colors[categoryIndex % colors.length];
}

/** Stable serialisation of a scheme, for projection cache keys. */
export function featureColorSchemeSignature(
  categoricalPalette?: FeatureCategoricalPaletteSpec,
  numericRamp?: FeatureNumericRampSpec
): string {
  if (categoricalPalette === undefined && numericRamp === undefined) return '';
  return JSON.stringify([categoricalPalette ?? null, numericRamp ?? null]);
}

/** A cell rendered as the canonical string form; `''` means "no usable value". */
export function normalizeFeatureCellValue(value: unknown): string {
  if (value === null || value === undefined) return '';
  return String(value);
}

export function featureNumericValue(value: string): number | undefined {
  if (value.trim() === '') return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function rgba(rgb: readonly [number, number, number], alpha: number): FeatureRgbaColor {
  return [rgb[0], rgb[1], rgb[2], alpha];
}

function interpolateRgb(
  low: readonly [number, number, number],
  high: readonly [number, number, number],
  t: number
): FeatureRgbColor {
  const clamped = Math.max(0, Math.min(1, t));
  return [
    Math.round(low[0] + (high[0] - low[0]) * clamped),
    Math.round(low[1] + (high[1] - low[1]) * clamped),
    Math.round(low[2] + (high[2] - low[2]) * clamped),
  ];
}

function getFiniteExtent(values: Array<number | undefined>): [number, number] | undefined {
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (const value of values) {
    if (value === undefined) continue;
    if (value < min) min = value;
    if (value > max) max = value;
  }
  return min === Number.POSITIVE_INFINITY ? undefined : [min, max];
}

/**
 * Resolve `'auto'`: a column whose every non-empty value parses as a finite number
 * is continuous; anything else is categorical.
 */
export function resolveFeatureFillColorMode(
  mode: FeatureFillColorMode,
  values: readonly string[]
): Exclude<FeatureFillColorMode, 'auto'> {
  if (mode !== 'auto') return mode;
  return values.every((value) => featureNumericValue(value) !== undefined)
    ? 'continuous'
    : 'categorical';
}

export interface AssignFeatureColorsOptions {
  /** One normalised cell value per feature, in feature order. `''` = no value. */
  values: readonly string[];
  mode: FeatureFillColorMode;
  alpha: number;
  categoricalPalette?: FeatureCategoricalPaletteSpec;
  numericRamp?: FeatureNumericRampSpec;
}

/**
 * Colour every feature from its column value.
 *
 * Returns a parallel array: `undefined` at a position means the feature had no
 * usable value, and the **caller must leave it on its default colour** rather than
 * inventing one. That distinction is why this returns an array of optionals instead
 * of a dense colour buffer — "unannotated" and "annotated with the first palette
 * entry" have to stay distinguishable.
 *
 * Category indices are assigned in first-seen feature order, so the same column
 * yields the same colours for a given element regardless of which kind draws it.
 */
export function assignFeatureColors({
  values,
  mode,
  alpha,
  categoricalPalette,
  numericRamp = DEFAULT_FEATURE_NUMERIC_RAMP,
}: AssignFeatureColorsOptions): Array<FeatureRgbaColor | undefined> {
  const colorForCategory = resolveCategoricalPalette(categoricalPalette);
  const colors = new Array<FeatureRgbaColor | undefined>(values.length).fill(undefined);

  const nonEmptyValues: string[] = [];
  for (const value of values) {
    if (value.trim() !== '') nonEmptyValues.push(value);
  }
  if (nonEmptyValues.length === 0) return colors;

  const resolvedMode = resolveFeatureFillColorMode(mode, nonEmptyValues);

  if (resolvedMode === 'continuous') {
    const numericValues = values.map((value) => featureNumericValue(value));
    const extent = getFiniteExtent(numericValues);
    if (!extent) return colors;
    const [min, max] = extent;
    const range = max - min;
    for (let index = 0; index < values.length; index += 1) {
      const value = numericValues[index];
      if (value === undefined) continue;
      const t = range === 0 ? 0.5 : (value - min) / range;
      colors[index] = rgba(interpolateRgb(numericRamp[0], numericRamp[1], t), alpha);
    }
    return colors;
  }

  const categoryIndexByValue = new Map<string, number>();
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value.trim() === '') continue;
    let categoryIndex = categoryIndexByValue.get(value);
    if (categoryIndex === undefined) {
      categoryIndex = categoryIndexByValue.size;
      categoryIndexByValue.set(value, categoryIndex);
    }
    colors[index] = rgba(colorForCategory(categoryIndex), alpha);
  }

  return colors;
}
