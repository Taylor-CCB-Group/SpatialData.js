export { SpatialLayer, migrateSpatialLayerProps, spatialLayerPropsSchema } from '@spatialdata/layers';
export type { SpatialLayerProps } from '@spatialdata/layers';

export { default as Sketch } from './Sketch';
export { default as SpatialDataTree } from './Tree';
export { default as Transforms } from './Transforms';
export { default as ImageView } from './ImageView';
export { default as Shapes } from './Shapes';
export { default as Table } from './Table';

// SpatialCanvas - composable spatial layers viewer
export { default as SpatialCanvas } from './SpatialCanvas';
export { 
  SpatialCanvasProvider,
  useSpatialCanvasStore,
  useSpatialCanvasActions,
  useSpatialCanvasStoreApi,
  createSpatialCanvasStore,
  useSpatialViewState,
  useViewStateUrl,
} from './SpatialCanvas';
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
  SpatialFeatureTooltipData,
  SpatialFeatureTooltipItem,
  SpatialCanvasTooltipRenderProps,
  SpatialFeatureTooltipProps,
} from './SpatialCanvas';
export { SpatialFeatureTooltip } from './SpatialCanvas';
