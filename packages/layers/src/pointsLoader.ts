import type { SpatialBounds } from '@spatialdata/core';
import type { PointsElement } from '@spatialdata/core';

export type PointsEncodingKind =
  | 'preloaded-columnar'
  | 'morton-tiled'
  | 'geoarrow-binary'
  | 'geoarrow-tiled';

export type PointsBatchFormat = 'columnar-ndarray' | 'arrow-record-batch';

export interface PointsLoaderCapabilities {
  kind: PointsEncodingKind;
  batchFormat: PointsBatchFormat;
  bounds?: SpatialBounds;
  supportsViewportTiles: boolean;
  supportsFeatureCodes?: boolean;
}

export interface ColumnarNdarrayPointsBatch {
  format: 'columnar-ndarray';
  data: ArrayLike<number>[];
  shape: number[];
  bounds?: SpatialBounds;
  loadMode?: string;
  pointCount?: number;
}

/** Placeholder for future GeoArrow strategies. */
export interface ArrowRecordBatchPointsBatch {
  format: 'arrow-record-batch';
  batch: unknown;
  bounds?: SpatialBounds;
  loadMode?: string;
  pointCount?: number;
}

export type PointsBatch = ColumnarNdarrayPointsBatch | ArrowRecordBatchPointsBatch;

export interface PointsLoadInBoundsOptions {
  bounds: SpatialBounds;
  featureCodes?: readonly number[];
  signal?: AbortSignal;
}

export interface PointsLoader {
  readonly capabilities: PointsLoaderCapabilities;
  loadInBounds(options: PointsLoadInBoundsOptions): Promise<PointsBatch | null>;
  loadAll?(options?: { signal?: AbortSignal }): Promise<PointsBatch>;
}

export interface PointsRenderResource {
  element: PointsElement;
  loader: PointsLoader;
}

export interface PointData {
  shape: number[];
  data: ArrayLike<number>[];
}

export function columnarBatchFromPointData(
  data: PointData,
  options?: { loadMode?: string; bounds?: SpatialBounds }
): ColumnarNdarrayPointsBatch {
  const pointCount =
    data.shape.length >= 2 && Number.isFinite(data.shape[1])
      ? data.shape[1]
      : (data.data[0]?.length ?? data.shape[0] ?? 0);
  return {
    format: 'columnar-ndarray',
    data: data.data,
    shape: data.shape,
    bounds: options?.bounds,
    loadMode: options?.loadMode,
    pointCount,
  };
}

export function pointDataFromColumnarBatch(batch: ColumnarNdarrayPointsBatch): PointData {
  return {
    data: batch.data,
    shape: batch.shape,
  };
}
