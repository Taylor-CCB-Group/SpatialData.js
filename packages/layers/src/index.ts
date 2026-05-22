export { SpatialLayer } from './SpatialLayer';
export type { SpatialLayerProps, SpatialShapesSublayer } from './spatialLayerProps';
export type { SpatialLayerRuntimeProps } from './SpatialLayer';
export { LabelsLayer, MAX_LABEL_CHANNELS } from './LabelsLayer';
export type { LabelsLayerProps, LabelsSelection } from './LabelsLayer';
export {
  createShapesDeckLayer,
  buildShapesPrebuiltData,
  normalizeShapeFeatureState,
  resolveShapeFeatureFromPick,
  resolveShapeFeatureFromPickInfo,
  resolveShapeTooltipFromPickInfo,
  resolveShapeTooltipRowIndex,
  type ShapesLayerPickEvent,
  type ShapeCircleRenderDatum,
  type ShapeFeatureRenderDatum,
  type ShapePolygonRenderDatum,
  type ShapesPrebuiltData,
  type ShapesRenderDataLike,
  type ShapeTooltipRuntimeData,
  type GeoarrowTableLike,
} from './shapesLayer';
export {
  spatialLayerPropsSchema,
  spatialSublayerSchema,
  migrateSpatialLayerProps,
  SPATIAL_LAYER_PROPS_SCHEMA_VERSION,
} from './spatialLayerProps';
