import { COLOR_PALLETE } from '@spatialdata/avivatorish';
import type { TableColumnData } from '@spatialdata/core';
import type { ShapesLayerConfig } from './types';

export type ShapeFillColorMode = NonNullable<ShapesLayerConfig['fillColorByColumn']>['mode'];

export interface BuildShapeFillColorByFeatureIdOptions {
  featureIds: string[];
  rowIndexByFeatureIndex: Int32Array;
  rowIndexByFeatureId?: Map<string, number>;
  column: TableColumnData | undefined;
  mode: ShapeFillColorMode;
  alpha: number;
}

const NUMERIC_LOW: [number, number, number] = [0, 64, 255];
const NUMERIC_HIGH: [number, number, number] = [255, 220, 0];

function normalizeCellValue(value: unknown): string {
  if (value === null || value === undefined) return '';
  return String(value);
}

function numericValue(value: string): number | undefined {
  if (value.trim() === '') return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function rgba(
  rgb: readonly [number, number, number],
  alpha: number
): [number, number, number, number] {
  return [rgb[0], rgb[1], rgb[2], alpha];
}

function interpolateRgb(
  low: readonly [number, number, number],
  high: readonly [number, number, number],
  t: number
): [number, number, number] {
  const clamped = Math.max(0, Math.min(1, t));
  return [
    Math.round(low[0] + (high[0] - low[0]) * clamped),
    Math.round(low[1] + (high[1] - low[1]) * clamped),
    Math.round(low[2] + (high[2] - low[2]) * clamped),
  ];
}

function getFiniteExtent(values: Array<number | undefined>): [number, number] | undefined {
  let min = Infinity;
  let max = -Infinity;
  for (const value of values) {
    if (value === undefined) continue;
    if (value < min) min = value;
    if (value > max) max = value;
  }
  return min === Infinity ? undefined : [min, max];
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
  rowIndexByFeatureId,
  column,
  mode,
  alpha,
}: BuildShapeFillColorByFeatureIdOptions): Record<string, [number, number, number, number]> {
  if (!column) return {};

  const valuesByFeature = featureIds.map((featureId, featureIndex) => {
    const rowIndex = rowIndexByFeatureId?.get(featureId) ?? rowIndexByFeatureIndex[featureIndex];
    const value =
      rowIndex !== undefined && rowIndex >= 0 ? normalizeCellValue(column[rowIndex]) : '';
    return { featureId, value };
  });
  const nonEmptyValues = valuesByFeature
    .map(({ value }) => value)
    .filter((value) => value.trim() !== '');
  if (nonEmptyValues.length === 0) return {};

  const resolvedMode = resolveShapeFillColorMode(mode, nonEmptyValues);
  const colors: Record<string, [number, number, number, number]> = {};

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
      colors[featureId] = rgba(interpolateRgb(NUMERIC_LOW, NUMERIC_HIGH, t), alpha);
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
    const paletteColor = COLOR_PALLETE[index % COLOR_PALLETE.length];
    colors[featureId] = rgba(paletteColor, alpha);
  }

  return colors;
}
