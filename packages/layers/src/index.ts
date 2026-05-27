export { SpatialLayer } from './SpatialLayer';
export type { SpatialLayerProps, SpatialShapesSublayer } from './spatialLayerProps';
export type { SpatialLayerRuntimeProps } from './SpatialLayer';
export { LabelsLayer, MAX_LABEL_CHANNELS } from './LabelsLayer';
export type { LabelsLayerProps, LabelsSelection } from './LabelsLayer';
export {
  createShapesDeckLayer,
  buildShapesPrebuiltData,
  DEFAULT_SHAPE_STROKE_WIDTH,
  DEFAULT_SHAPE_STROKE_WIDTH_MAX_PIXELS,
  DEFAULT_SHAPE_STROKE_WIDTH_MIN_PIXELS,
  DEFAULT_SHAPE_STROKE_WIDTH_UNITS,
  buildShapeFeatureStateRuntime,
  EMPTY_SHAPE_FEATURE_STATE_RUNTIME,
  isShapeFeatureStateRuntime,
  normalizeShapeFeatureState,
  resolveShapeFeatureFromPick,
  resolveShapeFeatureFromPickInfo,
  resolveShapeTooltipFromPickInfo,
  resolveShapeTooltipRowIndex,
  type ShapesLayerPickEvent,
  type ShapeCircleRenderDatum,
  type ShapeFeatureRenderDatum,
  type ShapeFeatureStateInput,
  type ShapeFeatureStateRuntime,
  type ShapePolygonRenderDatum,
  type SpatialShapesRuntimeSublayer,
  type ShapesPrebuiltData,
  type ShapesRenderDataLike,
  type ShapeStrokeWidthUnits,
  type ShapeTooltipRuntimeData,
  type GeoarrowTableLike,
} from './shapesLayer';
export {
  spatialLayerPropsSchema,
  spatialSublayerSchema,
  migrateSpatialLayerProps,
  SPATIAL_LAYER_PROPS_SCHEMA_VERSION,
} from './spatialLayerProps';
