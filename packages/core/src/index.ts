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
export {
  POINTS_PRELOAD_MAX_ROWS,
  PointsPreloadTooLargeError,
  exceedsPointsPreloadLimit,
  pointsPreloadTruncatedMessage,
  preloadedColumnarPointCount,
} from './pointsLimits.js';
export {
  enablePointsWorker,
  disablePointsWorker,
  ensurePointsWorker,
  filterColumnarByFeatureCodesInWorker,
  isPointsWorkerEnabled,
  setPointsWorkerDefaultEnabled,
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
