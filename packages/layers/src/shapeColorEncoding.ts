export type ShapeFillColorMode = 'auto' | 'categorical' | 'continuous';

export type ShapeRgbaColor = [number, number, number, number];
export type ShapeRgbColor = [number, number, number];

export interface BuildShapeFillColorByFeatureIdOptions {
  featureIds: readonly string[];
  /** Table row index per feature index, resolved by @spatialdata/core association helpers. */
  rowIndexByFeatureIndex: Int32Array;
  column: ArrayLike<unknown> | undefined;
  mode: ShapeFillColorMode;
  alpha: number;
  categoricalPalette?: readonly ShapeRgbColor[];
  numericRamp?: readonly [ShapeRgbColor, ShapeRgbColor];
}

export const DEFAULT_SHAPE_CATEGORICAL_PALETTE: readonly ShapeRgbColor[] = [
  [0, 0, 255],
  [0, 255, 0],
  [255, 0, 255],
  [255, 0, 0],
  [0, 255, 255],
  [255, 255, 0],
];

export const DEFAULT_SHAPE_NUMERIC_RAMP: readonly [ShapeRgbColor, ShapeRgbColor] = [
  [0, 64, 255],
  [255, 220, 0],
];

function normalizeCellValue(value: unknown): string {
  if (value === null || value === undefined) return '';
  return String(value);
}

function numericValue(value: string): number | undefined {
  if (value.trim() === '') return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function rgba(rgb: readonly [number, number, number], alpha: number): ShapeRgbaColor {
  return [rgb[0], rgb[1], rgb[2], alpha];
}

function interpolateRgb(
  low: readonly [number, number, number],
  high: readonly [number, number, number],
  t: number
): ShapeRgbColor {
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

export function resolveShapeFillColorMode(
  mode: ShapeFillColorMode,
  values: readonly string[]
): Exclude<ShapeFillColorMode, 'auto'> {
  if (mode !== 'auto') return mode;
  return values.every((value) => numericValue(value) !== undefined) ? 'continuous' : 'categorical';
}

export function buildShapeFillColorByFeatureId({
  featureIds,
  rowIndexByFeatureIndex,
  column,
  mode,
  alpha,
  categoricalPalette = DEFAULT_SHAPE_CATEGORICAL_PALETTE,
  numericRamp = DEFAULT_SHAPE_NUMERIC_RAMP,
}: BuildShapeFillColorByFeatureIdOptions): Record<string, ShapeRgbaColor> {
  if (!column) return {};

  const valuesByFeature = featureIds.map((featureId, featureIndex) => {
    const rowIndex = rowIndexByFeatureIndex[featureIndex];
    const value = rowIndex !== undefined ? normalizeCellValue(column[rowIndex]) : '';
    return { featureId, value };
  });
  const nonEmptyValues = valuesByFeature
    .map(({ value }) => value)
    .filter((value) => value.trim() !== '');
  if (nonEmptyValues.length === 0) return {};

  const resolvedMode = resolveShapeFillColorMode(mode, nonEmptyValues);
  const colors: Record<string, ShapeRgbaColor> = {};

  if (resolvedMode === 'continuous') {
    const numericValues = valuesByFeature.map(({ value }) => numericValue(value));
    const extent = getFiniteExtent(numericValues);
    if (!extent) return {};
    const [min, max] = extent;
    const range = max - min;

    for (const [featureIndex, featureId] of featureIds.entries()) {
      const value = numericValues[featureIndex];
      if (value === undefined) continue;
      const t = range === 0 ? 0.5 : (value - min) / range;
      colors[featureId] = rgba(interpolateRgb(numericRamp[0], numericRamp[1], t), alpha);
    }
    return colors;
  }

  const categoryIndexByValue = new Map<string, number>();
  for (const { featureId, value } of valuesByFeature) {
    if (value.trim() === '') continue;
    let index = categoryIndexByValue.get(value);
    if (index === undefined) {
      index = categoryIndexByValue.size;
      categoryIndexByValue.set(value, index);
    }
    const paletteColor = categoricalPalette[index % categoricalPalette.length];
    colors[featureId] = rgba(paletteColor, alpha);
  }

  return colors;
}
