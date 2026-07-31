/**
 * Shapes' half of table-column colouring: the addressing.
 *
 * The palette, ramp and auto-detect rule are in `featureColorEncoding` and shared
 * with labels. All this module adds is how a *shape* reaches its table cell —
 * feature index → row index (via the alignment core resolved) → cell.
 */

import {
  assignFeatureColors,
  DEFAULT_FEATURE_CATEGORICAL_PALETTE,
  DEFAULT_FEATURE_NUMERIC_RAMP,
  type FeatureCategoricalPaletteSpec,
  type FeatureColumnKind,
  type FeatureFillColorMode,
  type FeatureMissingValueOptions,
  type FeatureNumericRampSpec,
  type FeatureRgbaColor,
  type FeatureRgbColor,
  normalizeFeatureCellValue,
  resolveFeatureFillColorMode,
} from './featureColorEncoding';

export type ShapeFillColorMode = FeatureFillColorMode;

export type ShapeRgbaColor = FeatureRgbaColor;
export type ShapeRgbColor = FeatureRgbColor;

export interface BuildShapeFillColorByFeatureIdOptions {
  featureIds: readonly string[];
  /** Table row index per feature index, resolved by @spatialdata/core association helpers. */
  rowIndexByFeatureIndex: Int32Array;
  column: ArrayLike<unknown> | undefined;
  mode: ShapeFillColorMode;
  alpha: number;
  categoricalPalette?: FeatureCategoricalPaletteSpec;
  numericRamp?: FeatureNumericRampSpec;
  /** What the store declares the column to be; `'auto'` trusts it over the values. */
  columnKind?: FeatureColumnKind;
  missingValues?: FeatureMissingValueOptions;
}

export const DEFAULT_SHAPE_CATEGORICAL_PALETTE = DEFAULT_FEATURE_CATEGORICAL_PALETTE;

export const DEFAULT_SHAPE_NUMERIC_RAMP = DEFAULT_FEATURE_NUMERIC_RAMP;

export const resolveShapeFillColorMode = resolveFeatureFillColorMode;

export function buildShapeFillColorByFeatureId({
  featureIds,
  rowIndexByFeatureIndex,
  column,
  mode,
  alpha,
  categoricalPalette,
  numericRamp,
  columnKind,
  missingValues,
}: BuildShapeFillColorByFeatureIdOptions): Record<string, ShapeRgbaColor> {
  if (!column) return {};

  const values = featureIds.map((_featureId, featureIndex) => {
    const rowIndex = rowIndexByFeatureIndex[featureIndex];
    return rowIndex !== undefined ? normalizeFeatureCellValue(column[rowIndex]) : '';
  });

  const assigned = assignFeatureColors({
    values,
    mode,
    alpha,
    ...(categoricalPalette ? { categoricalPalette } : {}),
    ...(numericRamp ? { numericRamp } : {}),
    ...(columnKind ? { columnKind } : {}),
    ...(missingValues ? { missingValues } : {}),
  });

  const colors: Record<string, ShapeRgbaColor> = {};
  for (const [featureIndex, featureId] of featureIds.entries()) {
    const color = assigned[featureIndex];
    if (color) colors[featureId] = color;
  }
  return colors;
}
