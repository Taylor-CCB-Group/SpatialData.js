/**
 * @spatialdata/core
 *
 * Core library for interfacing with SpatialData stores in TypeScript/JavaScript
 */

export * from './models/index.js';
export {
  type GeopandasGeoParquetMetadata,
  inferShapesGeometryKindFromParquet,
  readGeopandasGeoParquetMetadata,
} from './models/VShapesSource.js';
export { tableToIndexColumnName } from './models/VTableSource.js';
export {
  featureCodeMapFromCatalog,
  mergeFeatureCountsIntoCatalog,
  remapRowFeatureCodes,
} from './pointsFeatures.js';
export {
  applyRenderCapToColumnar,
  DEFAULT_POINTS_MEMORY_CAP,
  DEFAULT_POINTS_RENDER_CAP,
  exceedsPointsPreloadLimit,
  POINTS_PRELOAD_MAX_ROWS,
  PointsPreloadTooLargeError,
  pointsFilteredMemoryCapMessage,
  pointsPreloadTruncatedMessage,
  preloadedColumnarPointCount,
  resolvePointsMemoryCap,
  resolvePointsRenderCap,
} from './pointsLimits.js';
export {
  type ColumnarNdarrayPointsBatch,
  type CorePointsLoader,
  createMortonTiledPointsLoader,
  createPointsLoaderForElement,
  createPreloadedColumnarPointsLoader,
  type PointsBatch,
  type PointsBatchFormat,
  type PointsEncodingKind,
  type PointsLoaderCapabilities,
  type PointsLoadInBoundsOptions,
  type PreloadedColumnarInput,
  resolvePointsEncoding,
} from './pointsLoader.js';
export type {
  PointsLoadOptions,
  PointsLoadProgress,
  PointsLoadResult,
} from './pointsLoadOptions.js';
export * from './pointsTiling.js';
export * from './shapes.js';
export * from './spatialViewFit.js';
export * from './store/index.js';
export * from './tableAssociations.js';
export * from './tooltip.js';
// export * from './schemas/index.js';
export * from './types.js';
export {
  disablePointsWorker,
  enablePointsWorker,
  ensurePointsWorker,
  filterColumnarByFeatureCodesInWorker,
  isPointsWorkerEnabled,
  setPointsWorkerDefaultEnabled,
  setPointsWorkerRequestTimeout,
} from './workers/index.js';
