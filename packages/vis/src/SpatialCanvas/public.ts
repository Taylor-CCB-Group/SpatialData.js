export {
  SpatialFeatureTooltip,
  type SpatialCanvasTooltipRenderProps,
  type SpatialFeatureTooltipData,
  type SpatialFeatureTooltipItem,
  type SpatialFeatureTooltipProps,
  type SpatialFeatureTooltipSection,
} from './SpatialFeatureTooltip';
export {
  SpatialCanvasProvider,
  useSpatialCanvasActions,
  useSpatialCanvasStore,
  useSpatialCanvasStoreApi,
} from './context';
export { useSpatialViewState, useViewStateUrl } from './hooks';
export { createSpatialCanvasStore } from './stores';
export type { SpatialCanvasStoreApi } from './stores';
export type * from './types';
export { layerConfig } from './layerConfig';
export { SpatialViewer } from './SpatialViewer';
export type { SpatialViewerProps } from './SpatialViewer';
export { VivSpatialViewer } from './VivSpatialViewer';
export {
  composeSpatialDeckLayers,
  shouldAutoFitSpatialView,
  shouldRenderInternalTooltip,
  SpatialCanvasViewer,
  useSpatialCanvasRenderer,
  useSpatialCanvasRendererFromLayerInputs,
} from './SpatialCanvasViewer';
export type {
  HoverTooltipMode,
  VivImageExtensionResolver,
  VivImageLayerContext,
  VivImagePropsResolver,
} from './SpatialCanvasViewer';
export { useImageLayerContext, ImageLayerContextProvider } from './ImageLayerContext';
export type { ImageLayerContextValue } from './ImageLayerContext';
export { mergeVivImagePassthroughProps } from './vivImagePassthrough';
export type { VivImagePassthroughOptions } from './vivImagePassthrough';
export {
  useLayerChannelState,
  mergeLayerChannelState,
  type LayerChannelConfig,
  type LayerChannelDefaults,
} from '@spatialdata/avivatorish';
export {
  renderStackOrder,
  renderStackToLayerInputs,
  resolveRenderStackHostLayers,
  sortLayersByRenderStackOrder,
} from './renderStackAdapters';
export type {
  RenderStackHostLayerResolver,
  RenderStackLayerInputs,
  UnknownRenderStackHostLayerHandler,
} from './renderStackAdapters';
export type {
  LabelsSpatialFeaturePickEvent,
  ShapesSpatialFeaturePickEvent,
  SpatialFeaturePickEvent,
  SpatialCanvasViewerProps,
  SpatialCanvasViewerRenderTooltip,
} from './SpatialCanvasViewer';
export type { SpatialCanvasProps } from './index';
export type {
  ImageLayerConfig as VivImageLayerConfig,
  ImageLoaderData,
  LayerLoadState,
} from './useLayerData';
// Reactive points feature state. Headless (panel-less) consumers read
// `pointsEngine` + `resolvePointsTarget` off the renderer-hook result, wrap a
// subtree in <PointsFeatureStateProvider>, and consume the usePoints* hooks.
export { PointsFeatureStateProvider, usePointsFeatureState } from './PointsFeatureState';
export type { PointsFeatureState, PointsFeatureStateProviderProps } from './PointsFeatureState';
export type { PointsDataEngine, PointsLoadTarget } from '@spatialdata/layers';
