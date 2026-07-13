import type { PointsElement } from '@spatialdata/core';
import type {
  PointsBatch,
  PointsLoader,
  PointsLoaderCapabilities,
  PointsLoadInBoundsOptions,
  PointsRenderResource,
} from './pointsLoader.js';

type CorePointsLoader = {
  readonly capabilities: PointsLoaderCapabilities;
  loadInBounds(options: PointsLoadInBoundsOptions): Promise<PointsBatch | null>;
  loadAll?(options?: { signal?: AbortSignal }): Promise<PointsBatch>;
};

export type {
  ArrowRecordBatchPointsBatch,
  ColumnarNdarrayPointsBatch,
  PointData,
  PointsBatch,
  PointsBatchFormat,
  PointsEncodingKind,
  PointsLoader,
  PointsLoaderCapabilities,
  PointsLoadInBoundsOptions,
  PointsRenderResource,
} from './pointsLoader.js';

export {
  columnarBatchFromPointData,
  pointDataFromColumnarBatch,
} from './pointsLoader.js';

export function coreLoaderToPointsLoader(loader: CorePointsLoader): PointsLoader {
  return loader;
}

export function createPointsRenderResource(
  element: PointsElement,
  loader: CorePointsLoader
): PointsRenderResource {
  return {
    element,
    loader: coreLoaderToPointsLoader(loader),
  };
}
