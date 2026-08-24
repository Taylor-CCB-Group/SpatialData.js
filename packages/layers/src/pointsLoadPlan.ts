import { resolvePointsMemoryCap } from '@spatialdata/core';

// The load-plan decision itself moved to `core` (D5 step 1) so `PointsResolver.plan()`
// can call it — `core` cannot import from `layers`. Re-exported here so no consumer
// import moves; the cache-key helpers below stay, they are a `layers` concern.
export {
  type PointsLoadPlan,
  type PointsLoadPlanInput,
  planPointsLoads,
} from '@spatialdata/core';

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
