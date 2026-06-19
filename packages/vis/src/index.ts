export {
  SpatialLayer,
  getRenderStackEntryIds,
  getRenderStackHostLayerIds,
  migrateSpatialLayerProps,
  renderStackEntrySchema,
  renderStackGroupEntrySchema,
  renderStackHostEntrySchema,
  renderStackSchema,
  renderStackSpatialElementTypeSchema,
  renderStackSpatialEntrySchema,
  spatialLayerPropsSchema,
  RENDER_STACK_SCHEMA_VERSION,
} from '@spatialdata/layers';
export type {
  RenderStack,
  RenderStackEntry,
  RenderStackGroupEntry,
  RenderStackHostEntry,
  RenderStackSpatialElementType,
  RenderStackSpatialEntry,
  SpatialLayerProps,
} from '@spatialdata/layers';

export { default as Sketch } from './Sketch';
export { default as SpatialDataTree } from './Tree';
export { default as Transforms } from './Transforms';
export { default as ImageView } from './ImageView';
export { default as Shapes } from './Shapes';
export { default as Table } from './Table';

// SpatialCanvas - composable spatial layers viewer
export { default as SpatialCanvas } from './SpatialCanvas';
export {
  SpatialCanvasViewer,
  SpatialCanvasProvider,
  useSpatialCanvasStore,
  useSpatialCanvasActions,
  useSpatialCanvasStoreApi,
  createSpatialCanvasStore,
  useSpatialViewState,
  useViewStateUrl,
  SpatialViewer,
  composeSpatialDeckLayers,
  renderStackOrder,
  renderStackToLayerInputs,
  resolveRenderStackHostLayers,
  shouldRenderInternalTooltip,
  shouldAutoFitSpatialView,
  sortLayersByRenderStackOrder,
  useSpatialCanvasRenderer,
} from './SpatialCanvas/public';
export type {
  SpatialCanvasStoreApi,
  SpatialCanvasState,
  SpatialCanvasActions,
  SpatialCanvasStore,
  ViewState,
  LayerConfig,
  LayerType,
  AvailableElement,
  ElementsByType,
  SpatialCanvasProps,
  SpatialViewerProps,
  SpatialCanvasViewerProps,
  SpatialCanvasViewerRenderTooltip,
  LabelsSpatialFeaturePickEvent,
  ShapesSpatialFeaturePickEvent,
  SpatialFeaturePickEvent,
  SpatialFeatureTooltipData,
  SpatialFeatureTooltipItem,
  SpatialFeatureTooltipSection,
  SpatialCanvasTooltipRenderProps,
  SpatialFeatureTooltipProps,
  RenderStackHostLayerResolver,
  RenderStackLayerInputs,
  UnknownRenderStackHostLayerHandler,
} from './SpatialCanvas/public';
export { SpatialFeatureTooltip } from './SpatialCanvas/public';
