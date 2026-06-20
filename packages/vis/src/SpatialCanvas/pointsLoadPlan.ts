import type { PointsTilingMetadata } from '@spatialdata/core';

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

export function pointsPreloadBlockedMessage(totalRows: number): string {
  return `${totalRows.toLocaleString()} points exceeds the preload limit — use a Morton-sorted element or tiled path`;
}

export function pointsTilingUnavailableMessage(totalRows: number): string {
  return `${totalRows.toLocaleString()} points cannot be tiled with this store (range reads unavailable) and exceeds the preload limit`;
}
