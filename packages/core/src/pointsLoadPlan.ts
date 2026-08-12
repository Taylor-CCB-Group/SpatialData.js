import type { PointsTilingMetadata } from './pointsTiling.js';

/**
 * Which points loads to schedule at the start of a load pass.
 *
 * Moved here from `@spatialdata/layers` (D5 step 1): `PointsResolver.plan()` is now
 * the caller that matters, and `core` cannot import from `layers`. The layers module
 * re-exports it, so no consumer import moves.
 */
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

/**
 * Decide which points loads to schedule at the start of a load pass.
 *
 * The two booleans are independent on purpose. Until the probe answers, we schedule
 * NEITHER: preloading a table we are about to tile wastes the whole read, and probing
 * a table we already hold resident answers a question nobody asked.
 */
export function planPointsLoads(input: PointsLoadPlanInput): PointsLoadPlan {
  const { wantsOptimized, metadataKnown, tiledMetadata, hasPreloaded } = input;
  const probeMetadata = wantsOptimized && !metadataKnown;
  const preloadFullTable =
    !hasPreloaded && (!wantsOptimized || (metadataKnown && tiledMetadata === null));
  return { probeMetadata, preloadFullTable };
}
