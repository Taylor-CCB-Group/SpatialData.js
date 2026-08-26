/**
 * @spatialdata/core
 *
 * Core library for interfacing with SpatialData stores in TypeScript/JavaScript
 */

// Combinators for the async-iterable streaming APIs (#175) — `streamPoints` and
// friends. Generic; nothing points-specific.
export { coalesceLatest, drainStream, sampleByStep } from './asyncStream.js';
// Resource Resolver contracts (ADR 0004).
export * from './engine/index.js';
// Memory accounting (ADR 0005).
export * from './memory/index.js';
export * from './models/index.js';
// The semantics that need the tree guards, not just the guards themselves: a
// consumer enumerating obs columns has to know that a group might be a
// categorical or a nullable column, and how to read each one. Exported so that
// knowledge lives here rather than being hand-rolled per consumer — see
// `classifyObsColumnNode` for the classification half.
export {
  isNullableEncoding,
  NULLABLE_ENCODING_KINDS,
  readNullableArray,
} from './models/nullableArrays.js';
export {
  type GeopandasGeoParquetMetadata,
  inferShapesGeometryKindFromParquet,
  readGeopandasGeoParquetMetadata,
} from './models/VShapesSource.js';
export { tableToIndexColumnName } from './models/VTableSource.js';
export {
  featureCodeMapFromCatalog,
  featureNamesForCodes,
  mergeFeatureCountsIntoCatalog,
  remapRowFeatureCodes,
  resolveFeatureSelectionCodes,
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
export {
  type PointsLoadPlan,
  type PointsLoadPlanInput,
  planPointsLoads,
} from './pointsLoadPlan.js';
export * from './pointsTileGrid.js';
export * from './pointsTiling.js';
// Render Stack schemas. Canonical here (ADR 0004 §5, amending ADR 0001): the
// Resource Resolver takes a Render Stack as input, so dependency direction forces
// the move. `layers` and `vis` retain their re-exports as compatibility shims —
// MDV consumes these as a data contract and no consumer import moves.
export * from './renderStack.js';
export * from './shapes.js';
export {
  type CoreShapesLoader,
  createFullShapesLoader,
  createShapesLoaderForElement,
  type DecodedShapesBatch,
  resolveShapesEncoding,
  type ShapesBatch,
  type ShapesBatchFormat,
  type ShapesEncodingKind,
  type ShapesLoaderCapabilities,
  type ShapesLoadInBoundsOptions,
} from './shapesLoader.js';
export * from './shapesPolygonTessellate.js';
export * from './spatialLayerProps.js';
export * from './spatialViewFit.js';
export * from './store/index.js';
export * from './tableAssociations.js';
export * from './tooltip.js';
// export * from './schemas/index.js';
export * from './types.js';
export {
  disableParquetWorker,
  type EnableParquetWorkerOptions,
  enableParquetWorker,
  ensureParquetWorker,
  filterColumnarByFeatureCodesInWorker,
  isParquetWorkerEnabled,
  setParquetWorkerDefaultEnabled,
  setParquetWorkerRequestTimeout,
} from './workers/index.js';
