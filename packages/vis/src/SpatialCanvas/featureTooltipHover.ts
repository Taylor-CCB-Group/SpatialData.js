import type { Deck } from '@deck.gl/core';
import { type SpatialFeatureTooltipData, mergeSpatialFeatureTooltips } from '@spatialdata/core';
import type { DeckGLRef, PickingInfo } from 'deck.gl';

const DEFAULT_PICK_RADIUS = 4;
const DEFAULT_PICK_DEPTH = 12;

export interface PickMultipleObjectsCapable {
  pickMultipleObjects(opts: {
    x: number;
    y: number;
    radius?: number;
    layerIds?: string[];
    depth?: number;
  }): PickingInfo[];
}

export function getDeckFromDeckGlRef(
  deckRef: { current: DeckGLRef | null } | undefined
): PickMultipleObjectsCapable | null {
  const deckGl = deckRef?.current;
  if (!deckGl) {
    return null;
  }
  return deckGl.deck ?? null;
}

export function normalizeDeckLayerId(rawLayerId: string): string {
  return rawLayerId.replace(/-#.*#$/, '');
}

export type FeatureTooltipResolver = (
  layerId: string,
  pickInfo: Pick<{ index?: number; object?: unknown }, 'index' | 'object'>
) => SpatialFeatureTooltipData | undefined;

export interface ResolveHoverFeatureTooltipOptions {
  /** When true (default), query all pickable layers under the cursor via the Deck instance. */
  aggregate?: boolean;
  deck?: PickMultipleObjectsCapable | null;
  /** Candidate logical deck layer ids for tooltip aggregation. Used to cap Deck's repeated pick passes. */
  pickLayerIds?: string[];
  pickRadius?: number;
  pickDepth?: number;
}

export function getAggregateHoverPickDepth(
  pickLayerIds: readonly string[] | undefined,
  pickDepth?: number
): number {
  if (typeof pickDepth === 'number') {
    return pickDepth;
  }
  return pickLayerIds?.length ? Math.max(1, pickLayerIds.length) : DEFAULT_PICK_DEPTH;
}

function collectPicks(
  info: PickingInfo,
  deck: PickMultipleObjectsCapable | null | undefined,
  aggregate: boolean,
  pickRadius: number,
  pickDepth: number,
  pickLayerIds: string[] | undefined
): PickingInfo[] {
  if (
    aggregate &&
    deck &&
    typeof deck.pickMultipleObjects === 'function' &&
    typeof info.x === 'number' &&
    typeof info.y === 'number'
  ) {
    return deck.pickMultipleObjects({
      x: info.x,
      y: info.y,
      radius: pickRadius,
      depth: pickDepth,
      layerIds: pickLayerIds?.length ? pickLayerIds : undefined,
    });
  }
  return [info];
}

export function resolveHoverFeatureTooltip(
  info: PickingInfo,
  getFeatureTooltip: FeatureTooltipResolver,
  options?: ResolveHoverFeatureTooltipOptions
): (SpatialFeatureTooltipData & { x: number; y: number }) | null {
  if (!info.picked || typeof info.x !== 'number' || typeof info.y !== 'number') {
    return null;
  }

  const aggregate = options?.aggregate !== false;
  const picks = collectPicks(
    info,
    options?.deck,
    aggregate,
    options?.pickRadius ?? DEFAULT_PICK_RADIUS,
    getAggregateHoverPickDepth(options?.pickLayerIds, options?.pickDepth),
    options?.pickLayerIds
  );

  const tooltips: SpatialFeatureTooltipData[] = [];
  const seenLayerIds = new Set<string>();

  for (const pick of picks) {
    if (!pick.picked) {
      continue;
    }
    const rawLayerId = typeof pick.layer?.id === 'string' ? pick.layer.id : '';
    const layerId = normalizeDeckLayerId(rawLayerId);
    if (!layerId || seenLayerIds.has(layerId)) {
      continue;
    }
    const tooltip = getFeatureTooltip(layerId, {
      index: pick.index,
      object: pick.object,
    });
    if (!tooltip) {
      continue;
    }
    seenLayerIds.add(layerId);
    tooltips.push(tooltip);
  }

  const merged = mergeSpatialFeatureTooltips(tooltips);
  if (!merged) {
    return null;
  }

  return {
    x: info.x,
    y: info.y,
    ...merged,
  };
}
