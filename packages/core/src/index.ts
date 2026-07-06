/**
 * @spatialdata/core
 *
 * Core library for interfacing with SpatialData stores in TypeScript/JavaScript
 */

// export * from './schemas/index.js';
export * from './types.js';
export * from './store/index.js';
export * from './models/index.js';
export * from './spatialViewFit.js';
export * from './pointsTiling.js';
export { mergeFeatureCountsIntoCatalog } from './pointsFeatures.js';
export {
  POINTS_PRELOAD_MAX_ROWS,
  DEFAULT_POINTS_MEMORY_CAP,
  DEFAULT_POINTS_RENDER_CAP,
  PointsPreloadTooLargeError,
  applyRenderCapToColumnar,
  exceedsPointsPreloadLimit,
  pointsPreloadTruncatedMessage,
  pointsFilteredMemoryCapMessage,
  preloadedColumnarPointCount,
  resolvePointsMemoryCap,
  resolvePointsRenderCap,
} from './pointsLimits.js';
export type { PointsLoadOptions, PointsLoadProgress, PointsLoadResult } from './pointsLoadOptions.js';
export {
  enablePointsWorker,
  disablePointsWorker,
  ensurePointsWorker,
  filterColumnarByFeatureCodesInWorker,
  isPointsWorkerEnabled,
  setPointsWorkerDefaultEnabled,
  setPointsWorkerRequestTimeout,
} from './workers/index.js';
export {
  createMortonTiledPointsLoader,
  createPointsLoaderForElement,
  createPreloadedColumnarPointsLoader,
  resolvePointsEncoding,
  type CorePointsLoader,
  type ColumnarNdarrayPointsBatch,
  type PreloadedColumnarInput,
  type PointsBatch,
  type PointsBatchFormat,
  type PointsEncodingKind,
  type PointsLoadInBoundsOptions,
  type PointsLoaderCapabilities,
} from './pointsLoader.js';
export * from './shapes.js';
export {
  inferShapesGeometryKindFromParquet,
  readGeopandasGeoParquetMetadata,
  type GeopandasGeoParquetMetadata,
} from './models/VShapesSource.js';
export { tableToIndexColumnName } from './models/VTableSource.js';
export * from './tableAssociations.js';
export * from './tooltip.js';
