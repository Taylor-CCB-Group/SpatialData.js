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

/**
 * Stable serialisation of a scheme, for projection cache keys.
 *
 * The missing-value policy belongs here too: changing a sentinel or how a missing
 * feature renders changes colours without touching the column, so a key that
 * omitted it would keep serving the previous table.
 */
export function featureColorSchemeSignature(
  categoricalPalette?: FeatureCategoricalPaletteSpec,
  numericRamp?: FeatureNumericRampSpec,
  missingValues?: FeatureMissingValueOptions
): string {
  if (
    categoricalPalette === undefined &&
    numericRamp === undefined &&
    missingValues === undefined
  ) {
    return '';
  }
  return JSON.stringify([
    categoricalPalette ?? null,
    numericRamp ?? null,
    missingValues ? [missingValues.treatAsMissing ?? null, missingValues.render ?? null] : null,
  ]);
}

/**
 * A cell rendered as the canonical string form; `''` means "no usable value".
 *
 * A non-finite NUMBER is a missing value, not the text `"NaN"`. In this domain
 * `NaN` is how a float column spells NA — a cell that failed a computation, an
 * embedding that did not converge — so it has to normalise the way `null` does.
 *
 * Getting this wrong was not a cosmetic bug: `'auto'` mode asks whether *every*
 * non-empty value parses as a finite number, so a single `NaN` in a `UMAP1` column
 * of half a million floats made the whole column categorical, and categorical mode
 * then gave every distinct float its own category — half a million hues of noise.
 * One bad cell, and the layer rendered as static.
 *
 * Deliberately typed rather than textual: only an actual `number` is treated this
 * way. The *string* `"NaN"` in a string column is left alone, because there we have
 * no way to tell a missing float from a category that happens to be spelled that
 * way, and silently dropping a real category is its own bug.
 */
export function normalizeFeatureCellValue(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'number' && !Number.isFinite(value)) return '';
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
 * What the store says the column is. Re-exported from `@spatialdata/core`'s
 * `TableColumnKind` so this module stays dependency-free.
 */
export type FeatureColumnKind = 'numeric' | 'categorical' | 'string' | 'boolean';

/**
 * Resolve `'auto'`.
 *
 * **Prefer the declared kind.** The loader knows whether a column is a float array
 * or an AnnData categorical, because it had to know in order to decode it, and that
 * answer is not recoverable from the decoded values: a float column with one `NaN`
 * looks non-numeric, and integer cluster codes look like a continuum. Both were real
 * bugs before the kind was plumbed through.
 *
 * `boolean` is two levels, so it colours categorically despite arriving in a numeric
 * typed array.
 *
 * The value-sniffing fallback survives only for callers with no kind to offer —
 * hand-built columns in tests, and any source that has not been taught to report
 * one. It keeps its old rule, warts and all, so those callers see no change.
 */
export function resolveFeatureFillColorMode(
  mode: FeatureFillColorMode,
  values: readonly string[],
  columnKind?: FeatureColumnKind
): Exclude<FeatureFillColorMode, 'auto'> {
  if (mode !== 'auto') return mode;
  if (columnKind === 'numeric') return 'continuous';
  if (columnKind !== undefined) return 'categorical';
  return values.every((value) => featureNumericValue(value) !== undefined)
    ? 'continuous'
    : 'categorical';
}

/**
 * What counts as missing, and what a missing feature should look like.
 *
 * JSON-serializable, because it travels in a saved layer config next to the palette.
 *
 * `null`, `undefined` and non-finite numbers are ALWAYS missing and are not
 * configurable — those are the language's and the domain's own spellings of "no
 * value", and letting a config claim `NaN` is a category would only ever be a bug.
 * What is configurable is the store-specific part: the sentinel STRINGS a particular
 * pipeline happens to write, which we cannot tell from real categories on our own.
 */
export interface FeatureMissingValueOptions {
  /**
   * Extra cell values to treat as missing, compared after trimming and
   * case-insensitively — e.g. `['NA', 'n/a', 'unknown', '-']`.
   *
   * Nothing here by default: a value that looks like a placeholder in one dataset
   * is a real category in another, and silently dropping a category is the same
   * class of bug as colouring `NaN`.
   */
  treatAsMissing?: readonly string[];
  /**
   * How a feature with no value renders.
   *
   *  - `'default'` (default) — no colour is assigned; the feature keeps whatever the
   *    layer would otherwise draw it as.
   *  - `'hide'` — fully transparent. On labels the fragment is discarded; on shapes
   *    the feature draws nothing.
   *  - an RGBA — an explicit colour, e.g. grey for "not measured".
   */
  render?: 'default' | 'hide' | FeatureRgbaColor;
}

const HIDDEN_RGBA: FeatureRgbaColor = [0, 0, 0, 0];

/** The colour a missing feature takes, or `undefined` to leave it on the default. */
function missingColor(
  options: FeatureMissingValueOptions | undefined
): FeatureRgbaColor | undefined {
  const render = options?.render;
  if (render === undefined || render === 'default') return undefined;
  if (render === 'hide') return HIDDEN_RGBA;
  return render;
}

/** Sentinel matcher, or `undefined` when there is nothing extra to match. */
function missingMatcher(
  options: FeatureMissingValueOptions | undefined
): ((value: string) => boolean) | undefined {
  const sentinels = options?.treatAsMissing;
  if (!sentinels || sentinels.length === 0) return undefined;
  const set = new Set(sentinels.map((s) => s.trim().toLowerCase()));
  return (value) => set.has(value.trim().toLowerCase());
}

export interface AssignFeatureColorsOptions {
  /** One normalised cell value per feature, in feature order. `''` = no value. */
  values: readonly string[];
  mode: FeatureFillColorMode;
  alpha: number;
  categoricalPalette?: FeatureCategoricalPaletteSpec;
  numericRamp?: FeatureNumericRampSpec;
  /**
   * What the store declares this column to be. Supply it whenever you have it —
   * `'auto'` trusts it in preference to sniffing the values. See
   * {@link resolveFeatureFillColorMode}.
   */
  columnKind?: FeatureColumnKind;
  missingValues?: FeatureMissingValueOptions;
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
  columnKind,
  missingValues,
}: AssignFeatureColorsOptions): Array<FeatureRgbaColor | undefined> {
  const colorForCategory = resolveCategoricalPalette(categoricalPalette);
  const colors = new Array<FeatureRgbaColor | undefined>(values.length).fill(undefined);

  // Sentinels are resolved once, up front, so a missing value is missing everywhere
  // that follows — the mode decision, the numeric extent, and the category set. A
  // sentinel that reached the category set would become a category of its own,
  // which is the bug this option exists to let callers avoid.
  const isSentinel = missingMatcher(missingValues);
  const isMissing = (value: string): boolean =>
    value.trim() === '' || (isSentinel?.(value) ?? false);
  const missingFill = missingColor(missingValues);
  const applyMissing = (index: number) => {
    if (missingFill) colors[index] = missingFill;
  };

  const nonEmptyValues: string[] = [];
  for (const value of values) {
    if (!isMissing(value)) nonEmptyValues.push(value);
  }
  if (nonEmptyValues.length === 0) {
    for (let index = 0; index < values.length; index += 1) applyMissing(index);
    return colors;
  }

  const resolvedMode = resolveFeatureFillColorMode(mode, nonEmptyValues, columnKind);

  if (resolvedMode === 'continuous') {
    const numericValues = values.map((value) =>
      isMissing(value) ? undefined : featureNumericValue(value)
    );
    const extent = getFiniteExtent(numericValues);
    if (!extent) {
      for (let index = 0; index < values.length; index += 1) applyMissing(index);
      return colors;
    }
    const [min, max] = extent;
    const range = max - min;
    for (let index = 0; index < values.length; index += 1) {
      const value = numericValues[index];
      if (value === undefined) {
        // Covers both a missing cell and — when the kind said numeric — a value
        // that would not parse. Neither belongs on the ramp.
        applyMissing(index);
        continue;
      }
      const t = range === 0 ? 0.5 : (value - min) / range;
      colors[index] = rgba(interpolateRgb(numericRamp[0], numericRamp[1], t), alpha);
    }
    return colors;
  }

  const categoryIndexByValue = new Map<string, number>();
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (isMissing(value)) {
      applyMissing(index);
      continue;
    }
    let categoryIndex = categoryIndexByValue.get(value);
    if (categoryIndex === undefined) {
      categoryIndex = categoryIndexByValue.size;
      categoryIndexByValue.set(value, categoryIndex);
    }
    colors[index] = rgba(colorForCategory(categoryIndex), alpha);
  }

  return colors;
}
