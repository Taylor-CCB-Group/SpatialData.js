import type { PointsTilingMetadata } from '@spatialdata/core';

export interface PointsLoadPlanInput {
  wantsOptimized: boolean;
  metadataKnown: boolean;
  tiledMetadata: PointsTilingMetadata | null | undefined;
  hasPreloaded: boolean;
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

/**
 * After a metadata probe completes, preload may still be required even when
 * `planPointsLoads` did not schedule it (metadata was unknown at plan time).
 */
export function shouldPreloadAfterMetadataProbe(
  probeRan: boolean,
  renderableMetadata: boolean,
  hasPreloaded: boolean
): boolean {
  return probeRan && !renderableMetadata && !hasPreloaded;
}
