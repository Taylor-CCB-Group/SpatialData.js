import {
  createPointsLoaderForElement,
  isTileablePointsMetadata,
  type PointsElement,
  type PointsTilingMetadata,
} from '@spatialdata/core';
import type { PointsRenderResource } from './pointsLoader.js';
import { createPointsRenderResource } from './pointsLoaderAdapter.js';

export interface ResolvePointsRenderResourceCache {
  preloaded?: {
    shape: number[];
    data: ArrayLike<number>[];
    featureCodes?: ArrayLike<number>;
  } | null;
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
    wantsOptimized && cache.metadataKnown && isTileablePointsMetadata(cache.tilingMetadata);

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
  options: ResolvePointsRenderResourceOptions & { preloadCacheKey?: string }
): string {
  const rowCount =
    cache.preloaded && cache.preloaded.shape.length >= 2
      ? cache.preloaded.shape[1]
      : (cache.preloaded?.data[0]?.length ?? 0);
  return [
    element.key,
    options.preloadCacheKey ?? '',
    options.experimentalOptimizations,
    cache.metadataKnown ? 'meta' : 'nometa',
    tilingSignature(cache.tilingMetadata),
    cache.preloaded ? `pre:${rowCount}` : 'nopre',
  ].join('|');
}

function tilingSignature(metadata: PointsTilingMetadata | null | undefined): string {
  if (!metadata) return '';
  if (metadata.kind === 'points-zarr') return `zarr:${metadata.elementPath}`;
  return `${metadata.parquetPath}|${metadata.supportsRowGroupRangeReads ? 'rg' : ''}`;
}
