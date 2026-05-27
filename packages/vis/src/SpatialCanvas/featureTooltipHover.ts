import {
  mergeSpatialFeatureTooltips,
  type SpatialFeatureTooltipData,
} from '@spatialdata/core';
import type { Deck } from '@deck.gl/core';
import type { DeckGLRef, PickingInfo } from 'deck.gl';

const DEFAULT_PICK_RADIUS = 4;
const DEFAULT_PICK_DEPTH = 12;

export function getDeckFromDeckGlRef(deckRef: { current: DeckGLRef | null } | undefined): Deck | null {
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
  deck?: Deck | null;
  pickRadius?: number;
  pickDepth?: number;
}

function collectPicks(
  info: PickingInfo,
  deck: Deck | null | undefined,
  aggregate: boolean,
  pickRadius: number,
  pickDepth: number
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
    options?.pickDepth ?? DEFAULT_PICK_DEPTH
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
