import { resolvePointsMemoryCap, type PointsTilingMetadata } from '@spatialdata/core';

export interface PointsPreloadCacheKeyInput {
  pointsMemoryCap?: number;
}

/** Cache key for preloaded scatter data (per element + memory cap). */
export function pointsPreloadCacheKey(
  elementKey: string,
  config: PointsPreloadCacheKeyInput
): string {
  const memoryCap = resolvePointsMemoryCap(config.pointsMemoryCap);
  return `${elementKey}|m${memoryCap}`;
}

export function deletePointsPreloadCacheForElement(
  cache: Map<string, unknown>,
  elementKey: string
): void {
  for (const key of [...cache.keys()]) {
    if (key === elementKey || key.startsWith(`${elementKey}|`)) {
      cache.delete(key);
    }
  }
}

export function hasPointsPreloadForElement(
  cache: Map<string, unknown>,
  elementKey: string
): boolean {
  for (const key of cache.keys()) {
    if (key === elementKey || key.startsWith(`${elementKey}|`)) {
      return true;
    }
  }
  return false;
}

export function resolvePointsPreloadData<T>(
  cache: Map<string, T>,
  elementKey: string,
  preloadCacheKey: string
): T | undefined {
  return cache.get(preloadCacheKey) ?? cache.get(elementKey);
}

export interface PointsLoadPlanInput {
  wantsOptimized: boolean;
  metadataKnown: boolean;
  tiledMetadata: PointsTilingMetadata | null | undefined;
  hasPreloaded: boolean;
  /** Known row count from parquet metadata, when available. */
  totalRows?: number;
}

export interface PointsLoadPlan {
  probeMetadata: boolean;
  preloadFullTable: boolean;
}

/** Decide which points loads to schedule at the start of a load pass. */
export function planPointsLoads(input: PointsLoadPlanInput): PointsLoadPlan {
  const { wantsOptimized, metadataKnown, tiledMetadata, hasPreloaded } = input;
  const probeMetadata = wantsOptimized && !metadataKnown;
  const preloadFullTable =
    !hasPreloaded && (!wantsOptimized || (metadataKnown && tiledMetadata === null));
  return { probeMetadata, preloadFullTable };
}

export interface ShouldPreloadAfterMetadataProbeInput {
  probeRan: boolean;
  renderableMetadata: boolean;
  hasPreloaded: boolean;
  totalRows?: number;
}

/**
 * After a metadata probe completes, preload may still be required even when
 * `planPointsLoads` did not schedule it (metadata was unknown at plan time).
 */
export function shouldPreloadAfterMetadataProbe(
  input: ShouldPreloadAfterMetadataProbeInput | boolean,
  renderableMetadata?: boolean,
  hasPreloaded?: boolean,
  totalRows?: number
): boolean {
  const normalized: ShouldPreloadAfterMetadataProbeInput =
    typeof input === 'boolean'
      ? {
          probeRan: input,
          renderableMetadata: renderableMetadata ?? false,
          hasPreloaded: hasPreloaded ?? false,
          totalRows,
        }
      : input;

  if (!normalized.probeRan || normalized.renderableMetadata || normalized.hasPreloaded) {
    return false;
  }
  return true;
}

export interface ShouldLoadPointsRowFeatureCodesInput {
  hasPreloaded: boolean;
  hasCached: boolean;
  inFlight: boolean;
  featureCodes?: readonly number[];
}

export function shouldLoadPointsRowFeatureCodes(
  input: ShouldLoadPointsRowFeatureCodesInput
): boolean {
  return input.hasPreloaded && !input.hasCached && !input.inFlight;
}

export function pointsPreloadBlockedMessage(totalRows: number): string {
  return `${totalRows.toLocaleString()} points exceeds the preload limit — use a Morton-sorted element or tiled path`;
}

export function pointsTilingUnavailableMessage(totalRows: number): string {
  return `${totalRows.toLocaleString()} points cannot be tiled with this store (range reads unavailable) and exceeds the preload limit`;
}
