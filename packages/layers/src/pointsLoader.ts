import type { PointsElement, PointsLoadMode, SpatialBounds } from '@spatialdata/core';

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
  loadMode?: PointsLoadMode;
  pointCount?: number;
  /** Per-point feature code, aligned row-for-row with {@link data}. Carried
   * through filtering/capping so the render path can build a GPU `featureCode`
   * attribute (colour-by-feature, per-code visibility). */
  featureCodes?: ArrayLike<number>;
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
  featureCodes?: ArrayLike<number>;
  /** Full dataset row count when preload was truncated. */
  totalRowCount?: number;
  preloadTruncated?: boolean;
  /** Rows scanned when loading with an active feature filter. */
  scannedRowCount?: number;
  /** Data was loaded with a source-side feature filter. */
  filterActive?: boolean;
}

export function columnarBatchFromPointData(
  data: PointData,
  options?: { loadMode?: PointsLoadMode; bounds?: SpatialBounds }
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
