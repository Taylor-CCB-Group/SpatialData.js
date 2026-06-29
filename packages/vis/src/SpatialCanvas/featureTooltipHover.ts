import type { Deck } from '@deck.gl/core';
import { type SpatialFeatureTooltipData, mergeSpatialFeatureTooltips } from '@spatialdata/core';
import type { DeckGLRef, PickingInfo } from 'deck.gl';

const DEFAULT_PICK_RADIUS = 4;
const DEFAULT_PICK_DEPTH = 12;

export interface PickMultipleObjectsCapable {
  props?: {
    layers?: unknown;
  };
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

function resolveLogicalLayerId(rawLayerId: string, logicalLayerIds: string[] | undefined): string {
  const normalized = normalizeDeckLayerId(rawLayerId);
  if (!logicalLayerIds?.length) {
    return normalized;
  }

  const candidates = logicalLayerIds
    .slice()
    .sort((a, b) => b.length - a.length)
    .map((id) => normalizeDeckLayerId(id));
  for (const candidate of candidates) {
    if (
      normalized === candidate ||
      normalized.startsWith(`${candidate}-`) ||
      normalized.endsWith(`-${candidate}`) ||
      normalized.includes(`-${candidate}-`)
    ) {
      return candidate;
    }
  }
  return normalized;
}

function collectDeckLayerIds(layers: unknown, ids: string[] = []): string[] {
  if (!layers) {
    return ids;
  }
  if (Array.isArray(layers)) {
    for (const layer of layers) {
      collectDeckLayerIds(layer, ids);
    }
    return ids;
  }
  if (typeof layers === 'object') {
    const id = Reflect.get(layers, 'id');
    if (typeof id === 'string') {
      ids.push(id);
    }
  }
  return ids;
}

function collectCurrentDeckLayerIds(deck: PickMultipleObjectsCapable | null | undefined): string[] {
  const ids: string[] = [];
  collectDeckLayerIds(deck?.props?.layers, ids);
  const layerManager =
    typeof deck === 'object' && deck !== null ? Reflect.get(deck, 'layerManager') : undefined;
  const getLayers =
    typeof layerManager === 'object' && layerManager !== null
      ? Reflect.get(layerManager, 'getLayers')
      : undefined;
  const flattenedLayers =
    typeof getLayers === 'function' ? getLayers.call(layerManager) : undefined;
  collectDeckLayerIds(flattenedLayers, ids);
  return ids;
}

function getSeenLogicalLayerIds(picks: PickingInfo[], logicalLayerIds: string[]): Set<string> {
  const seen = new Set<string>();
  for (const pick of picks) {
    const rawLayerId = typeof pick.layer?.id === 'string' ? pick.layer.id : '';
    const layerId = resolveLogicalLayerId(rawLayerId, logicalLayerIds);
    if (layerId) {
      seen.add(layerId);
    }
  }
  return seen;
}

export function resolveDeckPickLayerIds(
  deck: PickMultipleObjectsCapable | null | undefined,
  logicalLayerIds: string[] | undefined
): string[] | undefined {
  if (!logicalLayerIds?.length) {
    return undefined;
  }
  const logical = new Set(logicalLayerIds);
  const deckLayerIds = collectCurrentDeckLayerIds(deck);
  const resolved = deckLayerIds.filter(
    (id) => logical.has(id) || logical.has(resolveLogicalLayerId(id, logicalLayerIds))
  );
  const uniqueResolved = Array.from(new Set(resolved));
  return uniqueResolved.length > 0 ? uniqueResolved : logicalLayerIds;
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
    const layerIds = resolveDeckPickLayerIds(deck, pickLayerIds);
    const picks = deck.pickMultipleObjects({
      x: info.x,
      y: info.y,
      radius: pickRadius,
      depth: layerIds?.length ? Math.min(pickDepth, layerIds.length) : pickDepth,
      layerIds,
    });
    if (picks.length === 0) {
      return [info];
    }

    if (!pickLayerIds?.length) {
      return picks;
    }

    const seenLayerIds = getSeenLogicalLayerIds(picks, pickLayerIds);
    const missingLayerIds = pickLayerIds.filter(
      (layerId) => !seenLayerIds.has(normalizeDeckLayerId(layerId))
    );
    if (missingLayerIds.length === 0) {
      return picks;
    }

    // Most "missing" layers simply have no geometry under the cursor, so picking
    // each one individually performs a wasted `readPixels` GPU round-trip per
    // layer on every pointer move. Issue a single supplemental pick across all
    // missing layers instead (depth covers one hit per layer) to recover the
    // genuinely occluded ones without the per-layer readPixels storm.
    const supplementalPicks = deck.pickMultipleObjects({
      x: info.x,
      y: info.y,
      radius: pickRadius,
      depth: missingLayerIds.length,
      layerIds: resolveDeckPickLayerIds(deck, missingLayerIds),
    });
    return supplementalPicks.length > 0 ? [...picks, ...supplementalPicks] : picks;
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
    const layerId = resolveLogicalLayerId(rawLayerId, options?.pickLayerIds);
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
