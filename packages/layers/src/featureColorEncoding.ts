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

/**
 * Read one RGBA out of a buffer; `undefined` when the index is not covered.
 *
 * Bounded by the bytes actually present, not by `count` alone. `count` is a
 * caller's claim about its own buffer, and an over-stated one would otherwise
 * return a tuple of `undefined`s typed as a colour — which reaches deck as a
 * malformed attribute rather than as an error anyone can see.
 */
export function featureColorAt(
  buffer: FeatureColorBuffer | undefined,
  index: number
): FeatureRgbaColor | undefined {
  if (!buffer || !Number.isInteger(index) || index < 0) {
    return undefined;
  }
  const covered = Math.min(buffer.count, Math.floor(buffer.colors.length / 4));
  if (index >= covered) {
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
 * A category's colour named by the category itself, rather than by its position.
 *
 * This is the only form that survives the data changing. The other two are
 * positional — a colour is whatever the Nth category gets — and "the Nth category"
 * is a property of the features that happened to load, not of the column. Two
 * layers over the same annotation therefore disagree the moment their feature sets
 * differ, which is the normal case: a shapes layer walks the loader's geometry
 * order and a labels layer walks its raster ids.
 *
 * It is also the only form a host can use to say what it means. A viewer embedded
 * in an application whose user has already chosen "Tumour is red" cannot express
 * that as a list, because it does not know — and must not have to know — which
 * index `Tumour` will land on.
 *
 * Values are the column's cells in canonical string form (see
 * {@link normalizeFeatureCellValue}), so a numeric category is `'3'`, not `3`.
 */
export interface FeatureNamedCategoricalPalette {
  byValue: Readonly<Record<string, FeatureRgbColor>>;
  /**
   * Colour for a value the map does not name. Defaults to `'oklab'`, which gives
   * each unnamed category its own hue — an unnamed category stays visible and
   * distinguishable rather than silently merging into a single "other" bucket.
   */
  fallback?: 'oklab' | FeatureRgbColor;
}

/**
 * How to colour categories. JSON-serializable on purpose — this travels in a saved
 * layer config, so it is a name, a plain list of colours, or a plain object, never
 * a function.
 *
 *  - `'oklab'` — the points colour-by-feature scheme: OKLCh at fixed lightness and
 *               chroma, hue stepped by the golden angle. **Unbounded** — every
 *               category index gets its own well-separated hue, so a 30-category
 *               annotation does not repeat colours. The default.
 *  - a list    — your own colours, cycled. An empty list falls back to `'oklab'`
 *               rather than colouring nothing.
 *  - a map     — {@link FeatureNamedCategoricalPalette}. Prefer this whenever you
 *               know what the categories are; the two positional forms depend on
 *               which features loaded.
 */
export type FeatureCategoricalPaletteSpec =
  | 'oklab'
  | readonly FeatureRgbColor[]
  | FeatureNamedCategoricalPalette;

/**
 * The colours a continuous column ramps through, low to high.
 *
 * Two or more stops, spaced evenly across the domain and interpolated in RGB. Two
 * is the common case and the default; more exists because the ramps people
 * actually want are not two-stop — viridis, a diverging red/white/blue, and any
 * palette a host has already chosen for the same column elsewhere in its own UI
 * all need more, and approximating them with their endpoints does not just look
 * different, it loses the midpoint that made them meaningful.
 */
export type FeatureNumericRampSpec = readonly [
  FeatureRgbColor,
  FeatureRgbColor,
  ...FeatureRgbColor[],
];

/**
 * How a value's position along the ramp is measured.
 *
 *  - `'linear'` (default) — position is proportional to the value.
 *  - `'symlog'` — proportional to `sign(v)·log(1+|v|)`, so a column whose mass sits
 *    near zero with a long tail (counts, expression) spreads out instead of
 *    collapsing into the ramp's first stop. Symmetric log rather than plain log
 *    because it is defined at and below zero, which real columns reach.
 */
export type FeatureNumericScale = 'linear' | 'symlog';

/**
 * The values the ramp's endpoints stand for, `[low, high]`.
 *
 * Without one, the extent is measured from the features that loaded — so the same
 * column reads as a different scale on a layer covering a subset, and the colours
 * of two layers over one annotation are not comparable. Pin it to the column's own
 * range (which the store knows and the render does not) whenever you have it.
 *
 * Values outside the domain clamp to its endpoints rather than extrapolating.
 */
export type FeatureNumericDomain = readonly [number, number];

export const DEFAULT_FEATURE_CATEGORICAL_PALETTE: FeatureCategoricalPaletteSpec = 'oklab';

export const DEFAULT_FEATURE_NUMERIC_RAMP: FeatureNumericRampSpec = [
  [0, 64, 255],
  [255, 220, 0],
];

function isNamedCategoricalPalette(
  spec: FeatureCategoricalPaletteSpec
): spec is FeatureNamedCategoricalPalette {
  return typeof spec === 'object' && !Array.isArray(spec);
}

/**
 * Turn a palette spec into `(value, categoryIndex) → colour`.
 *
 * A function rather than an array because `'oklab'` has no length: its colour is a
 * pure function of the index, so there is no table to run out of. That is the whole
 * point of making it the default — the cycling of a fixed list is invisible in the
 * render (two cell types simply share a colour) and so is exactly the kind of bug
 * that survives review.
 *
 * Both arguments are passed because the spec decides which one is authoritative: a
 * named palette answers from the value, the positional forms from the index.
 */
export function resolveCategoricalPalette(
  spec: FeatureCategoricalPaletteSpec = DEFAULT_FEATURE_CATEGORICAL_PALETTE
): (value: string, categoryIndex: number) => FeatureRgbColor {
  if (spec === 'oklab') {
    return (_value, categoryIndex) => featureCodeToRgb(categoryIndex);
  }
  if (isNamedCategoricalPalette(spec)) {
    const { byValue, fallback = 'oklab' } = spec;
    const colorForUnnamed = fallback === 'oklab' ? featureCodeToRgb : (_index: number) => fallback;
    return (value, categoryIndex) => byValue[value] ?? colorForUnnamed(categoryIndex);
  }
  const colors = spec;
  if (colors.length === 0) {
    return (_value, categoryIndex) => featureCodeToRgb(categoryIndex);
  }
  return (_value, categoryIndex) => colors[categoryIndex % colors.length];
}

/** Everything about a column's encoding that is not the column itself. */
export interface FeatureColorScheme {
  categoricalPalette?: FeatureCategoricalPaletteSpec;
  numericRamp?: FeatureNumericRampSpec;
  numericDomain?: FeatureNumericDomain;
  numericScale?: FeatureNumericScale;
  missingValues?: FeatureMissingValueOptions;
}

/**
 * Stable serialisation of a scheme, for projection cache keys.
 *
 * Takes the whole scheme as one object so that adding a term to the encoding
 * cannot leave a call site silently keying on the old set — the failure mode being
 * a layer that keeps serving the previous colours after the scheme changed.
 *
 * The missing-value policy belongs here too: changing a sentinel or how a missing
 * feature renders changes colours without touching the column.
 */
export function featureColorSchemeSignature({
  categoricalPalette,
  numericRamp,
  numericDomain,
  numericScale,
  missingValues,
}: FeatureColorScheme = {}): string {
  if (
    categoricalPalette === undefined &&
    numericRamp === undefined &&
    numericDomain === undefined &&
    numericScale === undefined &&
    missingValues === undefined
  ) {
    return '';
  }
  return JSON.stringify([
    serializeCategoricalPalette(categoricalPalette),
    numericRamp ?? null,
    numericDomain ?? null,
    numericScale ?? null,
    missingValues ? [missingValues.treatAsMissing ?? null, missingValues.render ?? null] : null,
  ]);
}

/**
 * A named palette is serialised in sorted key order, because object key order is
 * insertion order and a caller rebuilding the same map per render need not insert
 * in a stable one. Two equal maps have to produce one string, or the layer rebuilds
 * its whole colour buffer on renders where nothing changed.
 */
function serializeCategoricalPalette(spec: FeatureCategoricalPaletteSpec | undefined): unknown {
  if (spec === undefined) return null;
  if (!isNamedCategoricalPalette(spec)) return spec;
  return [
    Object.entries(spec.byValue).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
    spec.fallback ?? null,
  ];
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

/**
 * Sample a multi-stop ramp at `t ∈ [0, 1]`, stops spaced evenly.
 *
 * `t` at exactly 1 has to land on the last stop rather than reading past it, which
 * is what the `length - 2` clamp is for — the top of the domain is the value most
 * likely to be looked at, and reading past the end would silently return the last
 * segment interpolated at 1 anyway on some inputs and `undefined` on others.
 */
function sampleRamp(stops: FeatureNumericRampSpec, t: number): FeatureRgbColor {
  const clamped = Math.max(0, Math.min(1, t));
  const scaled = clamped * (stops.length - 1);
  const lowIndex = Math.min(Math.floor(scaled), stops.length - 2);
  return interpolateRgb(stops[lowIndex], stops[lowIndex + 1], scaled - lowIndex);
}

/** Symmetric log, defined at and below zero. Matches d3's `scaleSymlog` at C = 1. */
function symlog(value: number): number {
  return Math.sign(value) * Math.log1p(Math.abs(value));
}

/** Where a value sits in `[min, max]`, as `t ∈ [0, 1]` before clamping. */
function rampPosition(value: number, min: number, max: number, scale: FeatureNumericScale): number {
  if (scale === 'symlog') {
    const low = symlog(min);
    const high = symlog(max);
    // A degenerate domain has no position to report; the midpoint is the one
    // answer that does not imply the value is at an extreme of a range it is not
    // actually spread over.
    return high === low ? 0.5 : (symlog(value) - low) / (high - low);
  }
  return max === min ? 0.5 : (value - min) / (max - min);
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
  /** Pin the ramp's endpoints instead of measuring them. See {@link FeatureNumericDomain}. */
  numericDomain?: FeatureNumericDomain;
  /** How position along the ramp is measured. See {@link FeatureNumericScale}. */
  numericScale?: FeatureNumericScale;
  /**
   * What the store declares this column to be. Supply it whenever you have it —
   * `'auto'` trusts it in preference to sniffing the values. See
   * {@link resolveFeatureFillColorMode}.
   */
  columnKind?: FeatureColumnKind;
  missingValues?: FeatureMissingValueOptions;
}

/**
 * Category ordering, and so — for the positional palettes — category colour.
 *
 * Sorted rather than first-seen. First-seen order is a property of the features
 * that loaded, not of the column, so it made the same annotation render in
 * different colours on a shapes layer and a labels layer over one table, and made a
 * saved config's colours drift whenever the data behind it changed.
 *
 * Numeric-looking values sort numerically, so cluster `10` follows cluster `9`
 * rather than cluster `1`; those are the commonest positional categories and
 * lexicographic order makes their palette look shuffled. Anything else sorts by
 * code unit — deliberately not `localeCompare`, whose answer depends on the
 * environment's locale data and would make the colours machine-dependent.
 */
function compareCategoryValues(a: string, b: string): number {
  const numericA = featureNumericValue(a);
  const numericB = featureNumericValue(b);
  if (numericA !== undefined && numericB !== undefined && numericA !== numericB) {
    return numericA - numericB;
  }
  if (numericA !== undefined && numericB === undefined) return -1;
  if (numericA === undefined && numericB !== undefined) return 1;
  return a < b ? -1 : a > b ? 1 : 0;
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
 * The encoding is a function of the COLUMN, not of the features that loaded:
 * categories are ordered by {@link compareCategoryValues} and the ramp can be
 * pinned with `numericDomain`. That is what lets the same annotation render the
 * same way on a shapes layer and on a labels layer over the same table, and what
 * makes a saved config's colours mean the same thing next time it is opened.
 */
export function assignFeatureColors({
  values,
  mode,
  alpha,
  categoricalPalette,
  numericRamp = DEFAULT_FEATURE_NUMERIC_RAMP,
  numericDomain,
  numericScale = 'linear',
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
    // A pinned domain is used even when nothing in view falls inside it: the point
    // of pinning is that the scale does not depend on what loaded.
    const extent = numericDomain ?? getFiniteExtent(numericValues);
    if (!extent) {
      for (let index = 0; index < values.length; index += 1) applyMissing(index);
      return colors;
    }
    const [min, max] = extent;
    for (let index = 0; index < values.length; index += 1) {
      const value = numericValues[index];
      if (value === undefined) {
        // Covers both a missing cell and — when the kind said numeric — a value
        // that would not parse. Neither belongs on the ramp.
        applyMissing(index);
        continue;
      }
      colors[index] = rgba(
        sampleRamp(numericRamp, rampPosition(value, min, max, numericScale)),
        alpha
      );
    }
    return colors;
  }

  // Two passes: the category set has to be complete and ordered before any colour
  // is assigned, because a positional palette's answer for the first feature
  // depends on categories that may only appear near the end of the column.
  const categoryIndexByValue = new Map<string, number>();
  for (const value of new Set(nonEmptyValues)) {
    categoryIndexByValue.set(value, 0);
  }
  const orderedValues = Array.from(categoryIndexByValue.keys()).sort(compareCategoryValues);
  for (const [categoryIndex, value] of orderedValues.entries()) {
    categoryIndexByValue.set(value, categoryIndex);
  }

  // The palette is consulted once per CATEGORY rather than once per feature — a
  // categorical column is a handful of distinct values over potentially millions of
  // rows. Each feature still gets its own tuple: these are handed out to callers
  // that store them per feature, and sharing one array between a category's
  // features would make any in-place edit recolour all of them.
  const rgbByValue = new Map<string, FeatureRgbColor>();
  for (const [value, categoryIndex] of categoryIndexByValue) {
    rgbByValue.set(value, colorForCategory(value, categoryIndex));
  }

  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (isMissing(value)) {
      applyMissing(index);
      continue;
    }
    const rgb = rgbByValue.get(value);
    if (rgb) colors[index] = rgba(rgb, alpha);
  }

  return colors;
}
