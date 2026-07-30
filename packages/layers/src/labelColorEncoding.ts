/**
 * Labels' half of table-column colouring and filtering: the addressing, plus the
 * GPU lookup table the bitmask shader samples.
 *
 * ## Why a LUT and not a colour buffer
 *
 * Shapes carry per-feature geometry, so feature-state becomes a per-feature colour
 * texture indexed by *feature index* (see `FlatPolygonLayer`). Labels carry no
 * geometry at all — a label is a pixel value in a raster — so the analogous texture
 * is indexed by *label id*: the shader samples the instance-id raster, gets an
 * integer, and looks that integer up. Same primitive ("table column → small texture
 * the shader samples per fragment"), same property that matters: a feature-state
 * change reuploads only this small texture and never the raster tiles.
 *
 * The addressing is dense — `colors[labelId]` — because the raster's pixel value is
 * already the index. Nothing needs to be sorted, hashed or searched at draw time.
 *
 * ## The API mirrors shapes deliberately
 *
 * `fillColorByFeatureId` / `hiddenFeatureIds` / `fadedFeatureIds` /
 * `filteredOpacityMultiplier` mean exactly what they mean for shapes, and a labels
 * feature id is the label's integer instance id rendered as a string — the same
 * identity the tooltip path already resolves against the associated table's obs
 * index (`tooltipRowIndexByFeatureId`). A caller that can filter a shapes layer can
 * filter a labels layer with the same code and the same ids.
 *
 * ## Colour vs. opacity in the LUT
 *
 * RGB is the label's resolved fill colour; A is a *modulation*, not an opacity:
 * `0` means hidden (the fragment is discarded), otherwise it scales the channel's
 * fill and outline opacities. Keeping A as a multiplier is what leaves the labels
 * channel's own fill/outline opacity sliders meaningful while a filter is active.
 */

import {
  assignFeatureColors,
  type FeatureFillColorMode,
  type FeatureRgbaColor,
  type FeatureRgbColor,
  normalizeFeatureCellValue,
} from './featureColorEncoding';

export type LabelFillColorMode = FeatureFillColorMode;
export type LabelRgbaColor = FeatureRgbaColor;
export type LabelRgbColor = FeatureRgbColor;

/**
 * Texel columns in the LUT texture, matching `FlatPolygonLayer`'s geometry
 * textures. The shader derives its texel coordinate from the same constant.
 */
export const LABEL_COLOR_LUT_WIDTH = 2048;

/**
 * Hard ceiling on the addressable label id (`2048 × 8192` texels). Beyond this a
 * dense LUT stops being a small texture, and the element is almost certainly not a
 * segmentation with per-instance annotations. The builder declines rather than
 * attempting a multi-hundred-megabyte upload.
 */
export const LABEL_COLOR_LUT_MAX_LABELS = LABEL_COLOR_LUT_WIDTH * 8192;

/** Serializable labels feature-state — the same shape shapes layers accept. */
export interface LabelFeatureState {
  /** Per-label fill colour, keyed by the label's integer id as a string. */
  fillColorByFeatureId?: Record<string, LabelRgbaColor>;
  /** Labels that must not draw at all. */
  hiddenFeatureIds?: string[];
  /** Labels that draw at `filteredOpacityMultiplier` of their normal opacity. */
  fadedFeatureIds?: string[];
  /** Opacity scale applied to faded labels. Defaults to 0.35, as for shapes. */
  filteredOpacityMultiplier?: number;
}

/** The Map/Set form the LUT builder consumes. */
export interface LabelFeatureStateRuntime {
  fillColorByFeatureId: Map<string, LabelRgbaColor>;
  hiddenFeatureIds: Set<string>;
  fadedFeatureIds: Set<string>;
  filteredOpacityMultiplier: number;
}

export type LabelFeatureStateInput = LabelFeatureState | LabelFeatureStateRuntime;

export const DEFAULT_LABEL_FILTERED_OPACITY_MULTIPLIER = 0.35;

/** Singleton for the common case of no feature-state at all. */
export const EMPTY_LABEL_FEATURE_STATE_RUNTIME = Object.freeze({
  fillColorByFeatureId: new Map(),
  hiddenFeatureIds: new Set(),
  fadedFeatureIds: new Set(),
  filteredOpacityMultiplier: DEFAULT_LABEL_FILTERED_OPACITY_MULTIPLIER,
} satisfies LabelFeatureStateRuntime);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export function isLabelFeatureStateRuntime(value: unknown): value is LabelFeatureStateRuntime {
  if (!isRecord(value)) return false;
  return (
    value.fillColorByFeatureId instanceof Map &&
    value.hiddenFeatureIds instanceof Set &&
    value.fadedFeatureIds instanceof Set &&
    typeof value.filteredOpacityMultiplier === 'number'
  );
}

/** Cache normalised runtimes by plain-object identity, as shapes does. */
const normalizeCache = new WeakMap<object, LabelFeatureStateRuntime>();

export function buildLabelFeatureStateRuntime(
  featureState: LabelFeatureStateInput
): LabelFeatureStateRuntime {
  if (isLabelFeatureStateRuntime(featureState)) return featureState;
  const cached = normalizeCache.get(featureState);
  if (cached) return cached;

  const fillColorByFeatureId = new Map<string, LabelRgbaColor>();
  const source = featureState.fillColorByFeatureId;
  if (source) {
    for (const key in source) {
      if (Object.hasOwn(source, key)) fillColorByFeatureId.set(key, source[key]);
    }
  }
  const result: LabelFeatureStateRuntime = {
    fillColorByFeatureId,
    hiddenFeatureIds: new Set(featureState.hiddenFeatureIds ?? []),
    fadedFeatureIds: new Set(featureState.fadedFeatureIds ?? []),
    filteredOpacityMultiplier:
      featureState.filteredOpacityMultiplier ?? DEFAULT_LABEL_FILTERED_OPACITY_MULTIPLIER,
  };
  normalizeCache.set(featureState, result);
  return result;
}

export function normalizeLabelFeatureState(
  featureState: LabelFeatureStateInput | undefined
): LabelFeatureStateRuntime {
  if (!featureState) return EMPTY_LABEL_FEATURE_STATE_RUNTIME;
  return buildLabelFeatureStateRuntime(featureState);
}

// ---------------------------------------------------------------------------
// Table column → per-label colour
// ---------------------------------------------------------------------------

export interface BuildLabelFillColorByFeatureIdOptions {
  /**
   * The associated table's obs index, already filtered to the rows annotating this
   * labels element (`AssociatedTableFeatureRows.rowIds`). Each entry is a label's
   * instance id as a string.
   */
  rowIds: readonly string[] | undefined;
  /** Row index per obs id, from the same association load. */
  rowIndexByFeatureId: Map<string, number> | undefined;
  column: ArrayLike<unknown> | undefined;
  mode: LabelFillColorMode;
  /**
   * Alpha written into each colour. Defaults to fully opaque so the labels
   * channel's own fill/outline opacity sliders stay in charge — unlike shapes,
   * where the fill alpha *is* the layer's opacity control.
   */
  alpha?: number;
  categoricalPalette?: readonly LabelRgbColor[];
  numericRamp?: readonly [LabelRgbColor, LabelRgbColor];
}

/**
 * Per-label fill colours keyed by label id, from one table column.
 *
 * Labels with no usable value are simply absent, exactly as for shapes: the caller
 * leaves them on the layer's default colour rather than inventing one.
 */
export function buildLabelFillColorByFeatureId({
  rowIds,
  rowIndexByFeatureId,
  column,
  mode,
  alpha = 255,
  categoricalPalette,
  numericRamp,
}: BuildLabelFillColorByFeatureIdOptions): Record<string, LabelRgbaColor> {
  if (!column || !rowIds || rowIds.length === 0) return {};

  const values = rowIds.map((rowId) => {
    const rowIndex = rowIndexByFeatureId?.get(rowId);
    return rowIndex !== undefined && rowIndex >= 0
      ? normalizeFeatureCellValue(column[rowIndex])
      : '';
  });

  const assigned = assignFeatureColors({
    values,
    mode,
    alpha,
    ...(categoricalPalette ? { categoricalPalette } : {}),
    ...(numericRamp ? { numericRamp } : {}),
  });

  const colors: Record<string, LabelRgbaColor> = {};
  for (const [index, rowId] of rowIds.entries()) {
    const color = assigned[index];
    if (color) colors[rowId] = color;
  }
  return colors;
}

// ---------------------------------------------------------------------------
// The GPU lookup table
// ---------------------------------------------------------------------------

/**
 * Parse a labels feature id back to the raster value it addresses.
 *
 * Returns `undefined` for anything that is not a non-negative integer. SpatialData
 * requires a labels table's instance keys to be the raster's integer values, but a
 * store can carry ids like `cell_17`; those simply cannot address a LUT, and are
 * dropped rather than silently mapped to index 0.
 */
export function parseLabelId(featureId: string): number | undefined {
  if (featureId === '' || !/^\d+$/.test(featureId)) return undefined;
  const parsed = Number(featureId);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

export interface LabelColorLut {
  /** RGBA per label id, `4 * labelCount` long. RGB = colour, A = opacity scale. */
  colors: Uint8Array;
  /** `maxLabelId + 1`; the shader treats ids at or beyond this as unannotated. */
  labelCount: number;
}

export interface BuildLabelColorLutOptions {
  featureState: LabelFeatureStateInput | undefined;
  /**
   * Colour for labels the feature-state says nothing about. Pass the layer's
   * channel colour so an unannotated label keeps drawing exactly as it does with
   * feature colouring switched off.
   */
  defaultColor: LabelRgbColor;
  /**
   * Upper bound on the label ids to allocate for, when the caller knows it (e.g.
   * from the raster's dtype). The builder never allocates beyond the largest id the
   * feature-state addresses, so this is only a further cap.
   */
  maxLabelId?: number;
}

/**
 * Build the per-label RGBA lookup table.
 *
 * Returns `undefined` when there is nothing to look up — no feature-state, no
 * parseable label ids, or an id space too large to address densely. `undefined`
 * means "draw with the plain uniform colour path", so the uncoloured case costs no
 * texture and no shader branch.
 */
export function buildLabelColorLut({
  featureState,
  defaultColor,
  maxLabelId,
}: BuildLabelColorLutOptions): LabelColorLut | undefined {
  const runtime = normalizeLabelFeatureState(featureState);
  if (
    runtime.fillColorByFeatureId.size === 0 &&
    runtime.hiddenFeatureIds.size === 0 &&
    runtime.fadedFeatureIds.size === 0
  ) {
    return undefined;
  }

  let highest = -1;
  const cap = maxLabelId !== undefined ? maxLabelId : Number.POSITIVE_INFINITY;
  const note = (featureId: string): void => {
    const labelId = parseLabelId(featureId);
    if (labelId === undefined || labelId > cap || labelId >= LABEL_COLOR_LUT_MAX_LABELS) {
      return;
    }
    if (labelId > highest) highest = labelId;
  };

  // One pass to size the table, so it is allocated exactly once at the right length.
  for (const featureId of runtime.fillColorByFeatureId.keys()) note(featureId);
  for (const featureId of runtime.hiddenFeatureIds) note(featureId);
  for (const featureId of runtime.fadedFeatureIds) note(featureId);

  if (highest < 0) return undefined;

  const labelCount = highest + 1;
  const colors = new Uint8Array(labelCount * 4);
  const fadeAlpha = Math.max(0, Math.min(255, Math.round(255 * runtime.filteredOpacityMultiplier)));

  // Default fill for every addressable label, fully opaque. Label 0 is background
  // and never drawn, but is filled for the same reason the rest are: the shader
  // reads the table without a bounds branch per fragment.
  for (let labelId = 0; labelId < labelCount; labelId += 1) {
    const offset = labelId * 4;
    colors[offset] = defaultColor[0];
    colors[offset + 1] = defaultColor[1];
    colors[offset + 2] = defaultColor[2];
    colors[offset + 3] = 255;
  }

  for (const [featureId, color] of runtime.fillColorByFeatureId) {
    const labelId = parseLabelId(featureId);
    if (labelId === undefined || labelId >= labelCount) continue;
    const offset = labelId * 4;
    colors[offset] = color[0];
    colors[offset + 1] = color[1];
    colors[offset + 2] = color[2];
    // A per-feature alpha below 255 scales this label's opacity, matching what the
    // same value means on a shapes fill.
    colors[offset + 3] = color[3] ?? 255;
  }

  // Fade before hide: a label in both sets must end up hidden.
  for (const featureId of runtime.fadedFeatureIds) {
    const labelId = parseLabelId(featureId);
    if (labelId === undefined || labelId >= labelCount) continue;
    const offset = labelId * 4;
    colors[offset + 3] = Math.round((colors[offset + 3] * fadeAlpha) / 255);
  }
  for (const featureId of runtime.hiddenFeatureIds) {
    const labelId = parseLabelId(featureId);
    if (labelId === undefined || labelId >= labelCount) continue;
    colors[labelId * 4 + 3] = 0;
  }

  return { colors, labelCount };
}

/** Whether a label draws at all, for the CPU-side picking path. */
export function isLabelVisibleInLut(lut: LabelColorLut | undefined, labelId: number): boolean {
  if (!lut) return true;
  if (!Number.isInteger(labelId) || labelId < 0 || labelId >= lut.labelCount) return true;
  return lut.colors[labelId * 4 + 3] > 0;
}
