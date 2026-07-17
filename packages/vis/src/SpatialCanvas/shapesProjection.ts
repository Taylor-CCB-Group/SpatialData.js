/**
 * Vis-side shapes projection helpers.
 *
 * These turn a shapes entry's resolved resources (render data, tooltip rows, the
 * fill-colour table rows) into the identity-stable, deck-ready inputs `getLayers`
 * needs — the `project()` half of ADR 0004's phase separation. They are pure
 * functions plus their cache-entry shapes; the stateful caches themselves live in
 * `useLayerData`.
 *
 * This is a WAYPOINT. ADR 0004 §4 puts `project()` on the Renderer Adapter in
 * `@spatialdata/layers`; Step 3 relocates this there. Extracting it to a vis module
 * now shrinks the hook and gives that later move a single small file to lift, without
 * pre-empting Step 3's interface decisions.
 */

import type { ShapesRenderData } from '@spatialdata/core';
import {
  buildShapeFeatureStateRuntime,
  EMPTY_SHAPE_FEATURE_STATE_RUNTIME,
  type ShapeFeatureStateRuntime,
  type ShapeFillColorMode,
  type ShapesPrebuiltData,
} from '@spatialdata/layers';
import type { LayerConfig, ShapesLayerConfig } from './types';

export interface ShapePrebuiltEntry {
  prebuilt: ShapesPrebuiltData;
  /** Serialised, sorted `hiddenFeatureIds` — used to detect when a rebuild is needed. */
  signature: string;
  /** The (merged) render data this prebuilt was built from. Rebuild on identity change. */
  source: ShapesRenderData;
}

export interface ShapeFillColorEntry {
  fillColorByFeatureId: Record<string, [number, number, number, number]>;
  signature: string;
  /** The resolver fill-colour rows this map was built from. Rebuild on identity change. */
  rowsSource?: unknown;
  /** The render data this map was built from. Rebuild on identity change. */
  renderSource?: ShapesRenderData;
}

export function getShapeFillColorAlpha(config: ShapesLayerConfig): number {
  return config.fillColor?.[3] ?? 180;
}

export function getShapeFillColorSignature(config: LayerConfig | undefined): string {
  if (config?.type !== 'shapes' || !config.fillColorByColumn?.columnName) {
    return '';
  }
  const mode: ShapeFillColorMode = config.fillColorByColumn.mode;
  return [config.fillColorByColumn.columnName, mode, String(getShapeFillColorAlpha(config))].join(
    '\u0001'
  );
}

/** Stable serialisation of `hiddenFeatureIds` for cache-invalidation comparison. */
export function serializeHiddenIds(ids?: string[]): string {
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

function mergeShapeFeatureStateForRender(
  config: ShapesLayerConfig,
  fillColorEntry: ShapeFillColorEntry | undefined
): ShapesLayerConfig['featureState'] {
  if (!config.fillColorByColumn?.columnName) {
    return config.featureState;
  }
  const fillColorByFeatureId = fillColorEntry?.fillColorByFeatureId ?? {};
  return {
    ...config.featureState,
    fillColorByFeatureId,
    // The outline is NOT pre-mirrored from the fill here. `@spatialdata/layers`
    // derives a lighter outline from each feature's resolved fill at render time
    // (see `deriveStrokeColor`), so a same-colour outline would be invisible. A
    // genuine per-feature stroke override from the caller (carried by the spread
    // above) still wins over that derivation.
  };
}

function getShapeFeatureStateSignature(
  config: ShapesLayerConfig,
  fillColorEntry: ShapeFillColorEntry | undefined
): string {
  const featureState = config.featureState;
  const fillColors = featureState?.fillColorByFeatureId;
  const strokeColors = featureState?.strokeColorByFeatureId;
  return [
    serializeHiddenIds(featureState?.hiddenFeatureIds),
    serializeHiddenIds(featureState?.fadedFeatureIds),
    String(featureState?.filteredOpacityMultiplier ?? ''),
    fillColorEntry?.signature ?? '',
    serializeColorByFeatureId(fillColors),
    serializeColorByFeatureId(strokeColors),
  ].join('\x01');
}

export function getStableShapeFeatureStateRuntime(
  layerId: string,
  config: ShapesLayerConfig,
  fillColorEntry: ShapeFillColorEntry | undefined,
  cache: Map<
    string,
    {
      signature: string;
      runtime: ShapeFeatureStateRuntime;
      fillColorEntry: ShapeFillColorEntry | undefined;
    }
  >
): ShapeFeatureStateRuntime {
  const signature = getShapeFeatureStateSignature(config, fillColorEntry);
  const cached = cache.get(layerId);
  // The entry's identity is part of the key, not just its signature string. The
  // signature is column-based (name/mode/alpha), but a column change serves the
  // PREVIOUS column's rows until the new ones load — so the entry's *data* can
  // change while its signature does not. `getShapeFillColorEntry` returns a fresh
  // entry object whenever the rows change, making identity the exact "the colours
  // are now different" signal; keying on it alone would leave the runtime one
  // column behind. It stays stable across bare re-renders (same cached entry), so
  // the fill-colour buffer is not thrashed.
  if (cached?.signature === signature && cached.fillColorEntry === fillColorEntry) {
    return cached.runtime;
  }

  const merged = mergeShapeFeatureStateForRender(config, fillColorEntry);
  const runtime = merged
    ? buildShapeFeatureStateRuntime(merged)
    : EMPTY_SHAPE_FEATURE_STATE_RUNTIME;
  cache.set(layerId, { signature, runtime, fillColorEntry });
  return runtime;
}
