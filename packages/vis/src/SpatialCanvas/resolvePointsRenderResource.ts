import {
  createPointsLoaderForElement,
  type PointsElement,
  type PointsTilingMetadata,
} from '@spatialdata/core';
import {
  createPointsRenderResource,
  type PointsRenderResource,
} from '@spatialdata/layers';

export interface ResolvePointsRenderResourceCache {
  preloaded?: { shape: number[]; data: ArrayLike<number>[] } | null;
  tilingMetadata?: PointsTilingMetadata | null;
  metadataKnown?: boolean;
}

export interface ResolvePointsRenderResourceOptions {
  experimentalOptimizations: 'auto' | 'off';
}

export function resolvePointsRenderResource(
  element: PointsElement,
  cache: ResolvePointsRenderResourceCache,
  options: ResolvePointsRenderResourceOptions
): PointsRenderResource | null {
  const wantsOptimized = options.experimentalOptimizations !== 'off';
  const canTile =
    wantsOptimized &&
    cache.metadataKnown &&
    cache.tilingMetadata?.supportsRowGroupRangeReads &&
    cache.tilingMetadata.bounds;

  const loader = createPointsLoaderForElement(element, {
    preloaded: cache.preloaded ?? null,
    tilingMetadata: canTile ? cache.tilingMetadata : null,
    wantsOptimized,
  });

  if (!loader) {
    return null;
  }

  return createPointsRenderResource(element, loader);
}

export function pointsRenderResourceSignature(
  element: PointsElement,
  cache: ResolvePointsRenderResourceCache,
  options: ResolvePointsRenderResourceOptions
): string {
  return [
    element.key,
    options.experimentalOptimizations,
    cache.metadataKnown ? 'meta' : 'nometa',
    cache.tilingMetadata?.parquetPath ?? '',
    cache.tilingMetadata?.supportsRowGroupRangeReads ? 'rg' : '',
    cache.preloaded ? `pre:${cache.preloaded.shape[0] ?? 0}` : 'nopre',
  ].join('|');
}
