// Framework-agnostic points loading/caching engine (LayerDataEngine step 1b).

// Compatibility shim (ADR 0004 §5). The Render Stack and SpatialLayerProps schemas
// are canonical in `@spatialdata/core`; these re-exports keep their existing import
// paths so no consumer — MDV especially — has to move. Removing the shim is a
// separate, deliberate deprecation, and is not part of the resolver work.
// Guarded by tests/renderStackShim.spec.ts, which asserts re-export by identity.
export type {
  RenderStack,
  RenderStackEntry,
  RenderStackGroupEntry,
  RenderStackHostEntry,
  RenderStackSpatialElementType,
  RenderStackSpatialEntry,
  SpatialLayerProps,
  SpatialShapesSublayer,
} from '@spatialdata/core';
export {
  getRenderStackEntryIds,
  getRenderStackHostLayerIds,
  migrateSpatialLayerProps,
  RENDER_STACK_SCHEMA_VERSION,
  renderStackEntrySchema,
  renderStackGroupEntrySchema,
  renderStackHostEntrySchema,
  renderStackSchema,
  renderStackSpatialElementTypeSchema,
  renderStackSpatialEntrySchema,
  SPATIAL_LAYER_PROPS_SCHEMA_VERSION,
  spatialLayerPropsSchema,
  spatialSublayerSchema,
} from '@spatialdata/core';
export {
  PointsDataEngine,
  type PointsDataEngineCallbacks,
  type PointsLoadStatus,
  type PointsLoadTarget,
  type PointsMatchingLoadState,
} from './engine/PointsDataEngine.js';
export type { LabelsLayerProps, LabelsSelection } from './LabelsLayer';
export { LabelsLayer, MAX_LABEL_CHANNELS } from './LabelsLayer';
export type { PointsLayerProps } from './PointsLayer';
export { PointsLayer } from './PointsLayer';
export { featureCodeToCssColor, featureCodeToRgb } from './pointsFeatureColor.js';
export { PointsFeatureColorExtension } from './pointsFeatureColorExtension.js';
export {
  type ArrowRecordBatchPointsBatch,
  type ColumnarNdarrayPointsBatch,
  columnarBatchFromPointData,
  type PointData,
  type PointsBatch,
  type PointsBatchFormat,
  type PointsEncodingKind,
  type PointsLoader,
  type PointsLoaderCapabilities,
  type PointsLoadInBoundsOptions,
  type PointsRenderResource,
  pointDataFromColumnarBatch,
} from './pointsLoader.js';
export {
  coreLoaderToPointsLoader,
  createPointsRenderResource,
} from './pointsLoaderAdapter.js';
// Points render-resource resolution and load planning.
// Relocated from @spatialdata/vis (SpatialCanvas) per
// docs/plans/layer-data-engine-decomposition.md — these are framework-agnostic
// (no React) and belong in layers. Re-exported from vis for MDV compatibility.
export * from './pointsLoadPlan.js';
export type { PointsRenderAttributes } from './pointsRenderAttributes.js';
export { buildPointsAttributes } from './pointsRenderAttributes.js';
export {
  DEFAULT_POINT_RADIUS_MAX_PIXELS,
  DEFAULT_POINT_RADIUS_MIN_PIXELS,
  DEFAULT_POINT_SIZE,
  MIN_POINT_SIZE_SCALE,
  POINT_SIZE_ZOOM_REFERENCE,
  zoomScaledPointSize,
} from './pointsScatterLayer.js';
export {
  formatPointsTileDebugTooltip,
  isPointsTileDebugPickObject,
  POINTS_TILE_DEBUG_PICK_KIND,
  type PointsTileDebugEntry,
  type PointsTileDebugPickObject,
  type PointsTileLoadProgress,
  type PointsTileStatus,
  reduceTileDebugEntries,
  tileDebugEntriesSignature,
  tileDebugStatusFillColor,
  tileDebugStatusLineColor,
} from './pointsTileDebug.js';
export {
  createTileDebugStore,
  createTiledPointsDebugHooks,
  type TileDebugStore,
  type TiledPointsDebugState,
} from './pointsTiledDebugHooks.js';
export type { PointsTileHandle, PointsTileLoadResult } from './pointsTileLoadCallbacks.js';
export * from './resolvePointsRenderResource.js';
export type { SpatialLayerRuntimeProps } from './SpatialLayer';
export { SpatialLayer } from './SpatialLayer';
export type {
  BuildShapeFillColorByFeatureIdOptions,
  ShapeFillColorMode,
  ShapeRgbaColor,
  ShapeRgbColor,
} from './shapeColorEncoding';
export {
  buildShapeFillColorByFeatureId,
  DEFAULT_SHAPE_CATEGORICAL_PALETTE,
  DEFAULT_SHAPE_NUMERIC_RAMP,
  resolveShapeFillColorMode,
} from './shapeColorEncoding';
export {
  buildShapeFeatureStateRuntime,
  buildShapesPrebuiltData,
  createShapesDeckLayer,
  DEFAULT_SHAPE_STROKE_WIDTH,
  DEFAULT_SHAPE_STROKE_WIDTH_MAX_PIXELS,
  DEFAULT_SHAPE_STROKE_WIDTH_MIN_PIXELS,
  DEFAULT_SHAPE_STROKE_WIDTH_UNITS,
  EMPTY_SHAPE_FEATURE_STATE_RUNTIME,
  type GeoarrowTableLike,
  isShapeFeatureStateRuntime,
  normalizeShapeFeatureState,
  resolveShapeFeatureFromPick,
  resolveShapeFeatureFromPickInfo,
  resolveShapeTooltipFromPickInfo,
  resolveShapeTooltipRowIndex,
  type ShapeCircleRenderDatum,
  type ShapeFeatureRenderDatum,
  type ShapeFeatureStateInput,
  type ShapeFeatureStateRuntime,
  type ShapePolygonRenderDatum,
  type ShapeStrokeWidthUnits,
  type ShapesLayerPickEvent,
  type ShapesPrebuiltData,
  type ShapesRenderDataLike,
  type ShapeTooltipRuntimeData,
  type SpatialShapesRuntimeSublayer,
} from './shapesLayer';
