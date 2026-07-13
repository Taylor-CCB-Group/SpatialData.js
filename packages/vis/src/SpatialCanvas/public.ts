export {
  type LayerChannelConfig,
  type LayerChannelDefaults,
  mergeLayerChannelState,
  useLayerChannelState,
} from '@spatialdata/avivatorish';
export type { PointsDataEngine, PointsLoadTarget } from '@spatialdata/layers';
export {
  SpatialCanvasProvider,
  useSpatialCanvasActions,
  useSpatialCanvasStore,
  useSpatialCanvasStoreApi,
} from './context';
export { useSpatialViewState, useViewStateUrl } from './hooks';
export type { ImageLayerContextValue } from './ImageLayerContext';
export { ImageLayerContextProvider, useImageLayerContext } from './ImageLayerContext';
export type { SpatialCanvasProps } from './index';
export { layerConfig } from './layerConfig';
export type { PointsFeatureState, PointsFeatureStateProviderProps } from './PointsFeatureState';
// Reactive points feature state. Headless (panel-less) consumers read
// `pointsEngine` + `resolvePointsTarget` off the renderer-hook result, wrap a
// subtree in <PointsFeatureStateProvider>, and consume the usePoints* hooks.
export { PointsFeatureStateProvider, usePointsFeatureState } from './PointsFeatureState';
export type {
  RenderStackHostLayerResolver,
  RenderStackLayerInputs,
  UnknownRenderStackHostLayerHandler,
} from './renderStackAdapters';
export {
  renderStackOrder,
  renderStackToLayerInputs,
  resolveRenderStackHostLayers,
  sortLayersByRenderStackOrder,
} from './renderStackAdapters';
export type {
  HoverTooltipMode,
  LabelsSpatialFeaturePickEvent,
  ShapesSpatialFeaturePickEvent,
  SpatialCanvasViewerProps,
  SpatialCanvasViewerRenderTooltip,
  SpatialFeaturePickEvent,
  VivImageExtensionResolver,
  VivImageLayerContext,
  VivImagePropsResolver,
} from './SpatialCanvasViewer';
export {
  composeSpatialDeckLayers,
  SpatialCanvasViewer,
  shouldAutoFitSpatialView,
  shouldRenderInternalTooltip,
  useSpatialCanvasRenderer,
  useSpatialCanvasRendererFromLayerInputs,
} from './SpatialCanvasViewer';
export {
  type SpatialCanvasTooltipRenderProps,
  SpatialFeatureTooltip,
  type SpatialFeatureTooltipData,
  type SpatialFeatureTooltipItem,
  type SpatialFeatureTooltipProps,
  type SpatialFeatureTooltipSection,
} from './SpatialFeatureTooltip';
export type { SpatialViewerProps } from './SpatialViewer';
export { SpatialViewer } from './SpatialViewer';
export type { SpatialCanvasStoreApi } from './stores';
export { createSpatialCanvasStore } from './stores';
export type * from './types';
export type {
  ImageLayerConfig as VivImageLayerConfig,
  ImageLoaderData,
  LayerLoadState,
} from './useLayerData';
export { VivSpatialViewer } from './VivSpatialViewer';
export type { VivImagePassthroughOptions } from './vivImagePassthrough';
export { mergeVivImagePassthroughProps } from './vivImagePassthrough';
