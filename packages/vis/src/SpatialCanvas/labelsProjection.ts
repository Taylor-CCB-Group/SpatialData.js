/**
 * Vis-side labels projection helpers — the labels twin of `shapesProjection`.
 *
 * These turn a labels entry's resolved resources (the fill-colour table rows) plus
 * its config into the identity-stable, deck-ready per-label lookup table
 * `getLayers` needs: the `project()` half of ADR 0004's phase separation. Pure
 * functions plus their cache-entry shapes; the stateful caches live in
 * `useLayerData`.
 *
 * The identity discipline is the point. `getLayers` runs on every render (a hover
 * re-renders for the tooltip), and the LUT can be megabytes for a large
 * segmentation — so it must be rebuilt only when the feature-state it encodes
 * actually changes, and hand deck the *same* object identity otherwise. That is
 * what the signature keys below buy: `LabelsLayer` compares the LUT by identity to
 * decide whether to re-upload its texture.
 */

import {
  buildLabelColorLut,
  buildLabelFillColorByFeatureId,
  featureColorSchemeSignature,
  type LabelColorLut,
  type LabelFillColorMode,
  type LabelRgbaColor,
  type LabelRgbColor,
} from '@spatialdata/layers';
import type { LabelsLayerConfig, LayerConfig } from './types';

/** Rows-derived per-label colours, cached per layer. */
export interface LabelFillColorEntry {
  fillColorByFeatureId: Record<string, LabelRgbaColor>;
  signature: string;
  /** The resolver fill-colour rows this map was built from. Rebuild on identity change. */
  rowsSource?: unknown;
}

export interface LabelColorLutEntry {
  /** `undefined` when the feature-state addresses nothing — draw the plain colour path. */
  lut: LabelColorLut | undefined;
  signature: string;
  fillColorEntry: LabelFillColorEntry | undefined;
}

/**
 * Alpha written into table-derived label colours.
 *
 * Fully opaque on purpose: a labels layer already exposes fill and outline opacity
 * per channel, and the LUT's alpha is a *filter* modulation. Baking a translucent
 * fill in here (as shapes does, where fill alpha is the only opacity control) would
 * silently halve the channel sliders' range.
 */
const LABEL_FILL_COLOR_ALPHA = 255;

export function getLabelFillColorSignature(config: LayerConfig | undefined): string {
  if (config?.type !== 'labels' || !config.fillColorByColumn?.columnName) {
    return '';
  }
  const mode: LabelFillColorMode = config.fillColorByColumn.mode;
  // The scheme is part of the key: swapping a palette changes every colour without
  // touching the column, so a column-only key would keep serving the old colours.
  const scheme = featureColorSchemeSignature(
    config.fillColorByColumn.categoricalPalette,
    config.fillColorByColumn.numericRamp
  );
  return [config.fillColorByColumn.columnName, mode, scheme].join('');
}

/** Stable serialisation of an id list for cache-invalidation comparison. */
function serializeIds(ids?: string[]): string {
  if (!ids || ids.length === 0) return '';
  return ids.slice().sort().join('\x00');
}

function serializeColorByFeatureId(
  colors?: Record<string, readonly [number, number, number, number]>
): string {
  if (!colors || Object.keys(colors).length === 0) return '';
  const entries = Object.entries(colors).sort(([a], [b]) => a.localeCompare(b));
  return `\x02${entries.length}:${JSON.stringify(entries)}`;
}

/** Per-label colours from one obs column, keyed by the label's instance id. */
export function buildLabelFillColorEntry(
  config: LabelsLayerConfig,
  rows:
    | {
        rowIds?: string[];
        rowIndexByFeatureId?: Map<string, number>;
        extraColumns?: Array<ArrayLike<unknown> | undefined>;
      }
    | undefined
): LabelFillColorEntry | undefined {
  const fillColorByColumn = config.fillColorByColumn;
  if (!fillColorByColumn?.columnName || !rows) return undefined;
  return {
    signature: getLabelFillColorSignature(config),
    fillColorByFeatureId: buildLabelFillColorByFeatureId({
      rowIds: rows.rowIds,
      rowIndexByFeatureId: rows.rowIndexByFeatureId,
      column: rows.extraColumns?.[0],
      mode: fillColorByColumn.mode,
      alpha: LABEL_FILL_COLOR_ALPHA,
      ...(fillColorByColumn.categoricalPalette
        ? { categoricalPalette: fillColorByColumn.categoricalPalette }
        : {}),
      ...(fillColorByColumn.numericRamp ? { numericRamp: fillColorByColumn.numericRamp } : {}),
    }),
    rowsSource: rows,
  };
}

/**
 * The feature-state a labels layer actually renders: the caller's own state with
 * the table-column colours merged in. Column colours lose to explicit per-label
 * overrides, matching how a shapes layer resolves the same conflict.
 */
function mergeLabelFeatureStateForRender(
  config: LabelsLayerConfig,
  fillColorEntry: LabelFillColorEntry | undefined
): LabelsLayerConfig['featureState'] {
  if (!config.fillColorByColumn?.columnName) {
    return config.featureState;
  }
  return {
    ...config.featureState,
    fillColorByFeatureId: {
      ...(fillColorEntry?.fillColorByFeatureId ?? {}),
      ...config.featureState?.fillColorByFeatureId,
    },
  };
}

function getLabelFeatureStateSignature(
  config: LabelsLayerConfig,
  fillColorEntry: LabelFillColorEntry | undefined,
  defaultColor: LabelRgbColor
): string {
  const featureState = config.featureState;
  return [
    serializeIds(featureState?.hiddenFeatureIds),
    serializeIds(featureState?.fadedFeatureIds),
    String(featureState?.filteredOpacityMultiplier ?? ''),
    fillColorEntry?.signature ?? '',
    serializeColorByFeatureId(featureState?.fillColorByFeatureId),
    // The default colour is baked into every unannotated LUT entry, so a channel
    // colour change genuinely invalidates the table.
    defaultColor.join(','),
  ].join('\x01');
}

/**
 * The layer's per-label LUT, with an identity that changes only when its contents
 * do — so `LabelsLayer` re-uploads its texture exactly when it must, and never on a
 * bare re-render.
 *
 * The cached entry holds the `fillColorEntry` identity as well as the signature,
 * for the same reason `getStableShapeFeatureStateRuntime` does: a column change
 * serves the PREVIOUS column's rows until the new ones load, so the entry's data
 * can change while its signature does not.
 */
export function getStableLabelColorLut(
  layerId: string,
  config: LabelsLayerConfig,
  fillColorEntry: LabelFillColorEntry | undefined,
  defaultColor: LabelRgbColor,
  cache: Map<string, LabelColorLutEntry>
): LabelColorLut | undefined {
  const signature = getLabelFeatureStateSignature(config, fillColorEntry, defaultColor);
  const cached = cache.get(layerId);
  if (cached?.signature === signature && cached.fillColorEntry === fillColorEntry) {
    return cached.lut;
  }

  const merged = mergeLabelFeatureStateForRender(config, fillColorEntry);
  const lut = merged ? buildLabelColorLut({ featureState: merged, defaultColor }) : undefined;
  cache.set(layerId, { lut, signature, fillColorEntry });
  return lut;
}
