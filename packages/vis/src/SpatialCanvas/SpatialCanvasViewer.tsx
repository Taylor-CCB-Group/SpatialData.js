import { type SpatialData, viewStateFromBounds } from '@spatialdata/core';
import type { RenderStack } from '@spatialdata/layers';
import { useMeasure } from '@uidotdev/usehooks';
import type { DeckGLProps, DeckGLRef, Layer, PickingInfo } from 'deck.gl';
import {
  type CSSProperties,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';
import { ensureCodecWorkers } from '../codecWorkers';
import { ImageLayerContextProvider } from './ImageLayerContext';
import {
  type SpatialCanvasTooltipRenderProps,
  SpatialFeatureTooltip,
  type SpatialFeatureTooltipData,
} from './SpatialFeatureTooltip';
import { SpatialViewer } from './SpatialViewer';
import { VivLoaderRegistryProvider } from './VivLoaderRegistry';
import {
  type HoverPointerEvent,
  getDeckFromDeckGlRef,
  isHoverDuringDrag,
  resolveHoverFeatureTooltip,
} from './featureTooltipHover';
import {
  type RenderStackHostLayerResolver,
  type RenderStackLayerInputs,
  type UnknownRenderStackHostLayerHandler,
  renderStackOrder,
  renderStackToLayerInputs,
  resolveRenderStackHostLayers,
  sortLayersByRenderStackOrder,
} from './renderStackAdapters';
import type { ElementsByType, LayerConfig, ShapesLayerPickEvent, ViewState } from './types';
import {
  type LabelFeaturePickEventData,
  type ShapeFeaturePickEventData,
  useLayerData,
} from './useLayerData';
import { useViewInteractionGate } from './useViewInteractionGate';
import { getAvailableElements } from './utils';
import type {
  VivImageExtensionResolver,
  VivImagePassthroughOptions,
  VivImagePropsResolver,
} from './vivImagePassthrough';

export type {
  VivImageExtensionResolver,
  VivImageLayerContext,
  VivImagePropsResolver,
} from './vivImagePassthrough';

export type SpatialCanvasViewerRenderTooltip =
  | false
  | ((props: SpatialCanvasTooltipRenderProps) => ReactNode);

/**
 * Hover tooltip / picking behaviour:
 * - `'off'`: no hover tooltip, and shape layers are made non-pickable (no
 *   autoHighlight, no picking buffer render) — the cheapest mode.
 * - `'simple'` (default): tooltip from the single top-most pick under the cursor.
 * - `'aggregate'`: tooltip aggregated across all layers under the cursor, which
 *   issues extra `pickMultipleObjects` GPU passes per pointer move.
 */
export type HoverTooltipMode = 'off' | 'simple' | 'aggregate';

/** Runtime narrowing for arbitrary strings (e.g. a `<select>` value) to a mode. */
export function isHoverTooltipMode(value: string): value is HoverTooltipMode {
  return value === 'off' || value === 'simple' || value === 'aggregate';
}

type SpatialFeaturePickEventRuntimeFields = {
  coordinateSystem: string | null;
  spatialData?: SpatialData | null;
  pickInfo: PickingInfo;
};

export type ShapesSpatialFeaturePickEvent = ShapeFeaturePickEventData &
  SpatialFeaturePickEventRuntimeFields;

export type LabelsSpatialFeaturePickEvent = LabelFeaturePickEventData &
  SpatialFeaturePickEventRuntimeFields;

export type SpatialFeaturePickEvent = ShapesSpatialFeaturePickEvent | LabelsSpatialFeaturePickEvent;

export interface SpatialCanvasViewerProps {
  spatialData?: SpatialData | null;
  coordinateSystem: string | null;
  renderStack?: RenderStack;
  /** @deprecated Prefer `renderStack.entries`. */
  layers?: Record<string, LayerConfig>;
  /** @deprecated Prefer `renderStack.entries`. */
  layerOrder?: string[];
  viewState: ViewState | null;
  onViewStateChange: (viewState: ViewState) => void;
  hostLayerResolver?: RenderStackHostLayerResolver;
  onUnknownHostLayer?: UnknownRenderStackHostLayerHandler;
  /** @deprecated Prefer host entries with `hostLayerResolver`. */
  deckLayers?: Layer[];
  deckProps?: Partial<DeckGLProps>;
  onHover?: (info: PickingInfo) => void;
  onClick?: (info: PickingInfo) => void;
  onFeatureHover?: (event: SpatialFeaturePickEvent) => void;
  onFeatureClick?: (event: SpatialFeaturePickEvent) => void;
  onShapeHover?: (event: ShapesLayerPickEvent) => void;
  onShapeClick?: (event: ShapesLayerPickEvent) => void;
  renderTooltip?: SpatialCanvasViewerRenderTooltip;
  tooltipContainer?: HTMLElement | null;
  showLoadingOverlay?: boolean;
  autoFit?: boolean;
  style?: CSSProperties;
  /**
   * Hover tooltip / picking behaviour: `'off'` | `'simple'` (default) |
   * `'aggregate'`. See {@link HoverTooltipMode}. `'aggregate'` is more expensive
   * (extra GPU pick passes per move); `'off'` disables shape picking entirely.
   */
  hoverTooltipMode?: HoverTooltipMode;
  /** Global fallback Viv LayerExtension instances for image layers. */
  vivImageExtensions?: unknown[];
  /** Per-image LayerExtension factory (runtime attachment). */
  vivImageExtensionResolver?: VivImageExtensionResolver;
  /** Per-image Viv prop overrides merged after saved `vivLayerProps` (runtime attachment). */
  vivImagePropsResolver?: VivImagePropsResolver;
}

interface AutoFitInput {
  autoFit: boolean;
  hasEnabledLayers: boolean;
  width: number;
  height: number;
  isBlocking: boolean;
  viewState: ViewState | null;
}

export function shouldAutoFitSpatialView({
  autoFit,
  hasEnabledLayers,
  width,
  height,
  isBlocking,
  viewState,
}: AutoFitInput): boolean {
  return (
    autoFit && hasEnabledLayers && width > 0 && height > 0 && !isBlocking && viewState === null
  );
}

export function composeSpatialDeckLayers(
  generatedLayers: Layer[],
  externalLayers: Layer[] = []
): Layer[] {
  return [...generatedLayers.filter(Boolean), ...externalLayers.filter(Boolean)];
}

export function getEmptyElementsByType(): ElementsByType {
  return { images: [], shapes: [], points: [], labels: [] };
}

export function shouldRenderInternalTooltip(
  renderTooltip: SpatialCanvasViewerRenderTooltip | undefined
): boolean {
  return renderTooltip !== false;
}

export interface UseSpatialCanvasRendererOptions {
  spatialData?: SpatialData | null;
  coordinateSystem: string | null;
  renderStack: RenderStack;
  /**
   * Current view state.  When `undefined` the auto-fit effect is skipped
   * entirely, letting the caller manage auto-fit externally (e.g. in a
   * child component that subscribes to `viewState` independently so that
   * pan frames don't cause this hook to re-run).
   */
  viewState?: ViewState | null;
  /**
   * Required if `viewState` is provided and auto-fit is desired.
   */
  onViewStateChange?: (viewState: ViewState) => void;
  width: number;
  height: number;
  hostLayerResolver?: RenderStackHostLayerResolver;
  onUnknownHostLayer?: UnknownRenderStackHostLayerHandler;
  autoFit?: boolean;
  vivImageExtensions?: unknown[];
  vivImageExtensionResolver?: VivImageExtensionResolver;
  vivImagePropsResolver?: VivImagePropsResolver;
}

interface UseSpatialCanvasRendererFromLayerInputsOptions {
  spatialData?: SpatialData | null;
  coordinateSystem: string | null;
  layerInputs: RenderStackLayerInputs;
  renderOrder?: string[];
  viewState?: ViewState | null;
  onViewStateChange?: (viewState: ViewState) => void;
  width: number;
  height: number;
  hostDeckLayers?: Layer[];
  externalDeckLayers?: Layer[];
  sortDeckLayers?: boolean;
  autoFit?: boolean;
  vivPassthrough?: VivImagePassthroughOptions;
  /**
   * When false, shape layers are built non-pickable (autoHighlight off), so deck
   * does not render their geometry into the picking buffer. Used both for the
   * "off" tooltip mode and to suppress picking during pan/zoom. Defaults to true.
   */
  pickingEnabled?: boolean;
}

export function useSpatialCanvasRendererFromLayerInputs({
  spatialData,
  coordinateSystem,
  layerInputs,
  renderOrder,
  viewState,
  onViewStateChange,
  width,
  height,
  hostDeckLayers,
  externalDeckLayers,
  sortDeckLayers,
  autoFit = true,
  vivPassthrough,
  pickingEnabled = true,
}: UseSpatialCanvasRendererFromLayerInputsOptions) {
  ensureCodecWorkers();

  const availableElements = useMemo(() => {
    if (!spatialData || !coordinateSystem) {
      return getEmptyElementsByType();
    }
    return getAvailableElements(spatialData, coordinateSystem);
  }, [spatialData, coordinateSystem]);

  const resolvedLayerOrder = renderOrder ?? layerInputs.layerOrder;

  const layerData = useLayerData(
    layerInputs.layers,
    layerInputs.layerOrder,
    availableElements,
    coordinateSystem,
    spatialData ?? undefined,
    vivPassthrough
  );

  const generatedDeckLayers = layerData.getLayers({ pickingEnabled });
  const deckLayers = useMemo(() => {
    const composed = composeSpatialDeckLayers(generatedDeckLayers, [
      ...(hostDeckLayers ?? []),
      ...(externalDeckLayers ?? []),
    ]);
    return sortDeckLayers ? sortLayersByRenderStackOrder(composed, resolvedLayerOrder) : composed;
  }, [externalDeckLayers, generatedDeckLayers, hostDeckLayers, resolvedLayerOrder, sortDeckLayers]);
  const vivLayerProps = useMemo(
    () => layerData.getVivLayerProps(),
    // useLayerData returns a fresh object every render, so we intentionally depend
    // on its stable members (the useCallback'd getter plus the memoized load flags)
    // rather than `layerData` itself, which would recompute this on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [layerData.getVivLayerProps, vivPassthrough, layerData.isBlocking, layerData.isLoading]
  );

  const enabledLayerIds = useMemo(() => {
    return new Set(layerInputs.layerOrder.filter((id) => layerInputs.layers[id]?.visible));
  }, [layerInputs.layerOrder, layerInputs.layers]);
  const hasEnabledLayers = enabledLayerIds.size > 0;
  const hasExternalDeckLayers =
    (externalDeckLayers?.length ?? 0) > 0 || (hostDeckLayers?.length ?? 0) > 0;
  const hasRenderableInputs = hasEnabledLayers || hasExternalDeckLayers;
  const hasLayersDrawn = deckLayers.length > 0 || vivLayerProps.length > 0;

  useEffect(() => {
    // Skip auto-fit when viewState is not managed by this hook (caller handles it).
    if (viewState === undefined || !onViewStateChange) return;
    if (
      !shouldAutoFitSpatialView({
        autoFit,
        hasEnabledLayers,
        width,
        height,
        isBlocking: layerData.isBlocking,
        viewState,
      })
    ) {
      return;
    }
    const bounds = layerData.getWorldBoundsForVisibleLayers();
    onViewStateChange(
      bounds ? viewStateFromBounds(bounds, width, height) : { target: [0, 0], zoom: 0 }
    );
    // useLayerData returns a fresh object every render, so we intentionally depend
    // on its stable members (memoized flag + useCallback'd bounds getter) rather
    // than `layerData` itself, which would re-run this effect on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    autoFit,
    hasEnabledLayers,
    height,
    layerData.isBlocking,
    layerData.getWorldBoundsForVisibleLayers,
    onViewStateChange,
    viewState,
    width,
  ]);

  return {
    ...layerData,
    availableElements,
    deckLayers,
    enabledLayerIds,
    generatedDeckLayers,
    hasEnabledLayers,
    hasExternalDeckLayers,
    hasLayersDrawn,
    hasRenderableInputs,
    layerOrder: resolvedLayerOrder,
    vivLayerProps,
  };
}

export function useSpatialCanvasRenderer({
  spatialData,
  coordinateSystem,
  renderStack,
  viewState,
  onViewStateChange,
  width,
  height,
  hostLayerResolver,
  onUnknownHostLayer,
  autoFit = true,
  vivImageExtensions,
  vivImageExtensionResolver,
  vivImagePropsResolver,
}: UseSpatialCanvasRendererOptions) {
  const layerInputs = useMemo(() => renderStackToLayerInputs(renderStack), [renderStack]);
  const hostDeckLayers = useMemo(
    () => resolveRenderStackHostLayers(renderStack, hostLayerResolver, onUnknownHostLayer),
    [hostLayerResolver, onUnknownHostLayer, renderStack]
  );
  const resolvedLayerOrder = useMemo(
    () => renderStackOrder(renderStack, layerInputs.layerOrder),
    [layerInputs.layerOrder, renderStack]
  );
  const vivPassthrough = useMemo(
    (): VivImagePassthroughOptions => ({
      vivImageExtensions,
      vivImageExtensionResolver,
      vivImagePropsResolver,
    }),
    [vivImageExtensionResolver, vivImageExtensions, vivImagePropsResolver]
  );

  return useSpatialCanvasRendererFromLayerInputs({
    spatialData,
    coordinateSystem,
    layerInputs,
    renderOrder: resolvedLayerOrder,
    viewState,
    onViewStateChange,
    width,
    height,
    hostDeckLayers,
    sortDeckLayers: true,
    autoFit,
    vivPassthrough,
  });
}

const viewerRootStyle: CSSProperties = {
  width: '100%',
  height: '100%',
  minHeight: 0,
  minWidth: 0,
  position: 'relative',
  overflow: 'hidden',
};

const placeholderStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  height: '100%',
  color: '#666',
  fontSize: '14px',
};

const overlayStyle: CSSProperties = {
  position: 'absolute',
  top: 8,
  right: 8,
  padding: '4px 8px',
  backgroundColor: 'rgba(0,0,0,0.7)',
  color: '#fff',
  fontSize: '11px',
  borderRadius: 4,
};

function SpatialCanvasViewerInner({
  spatialData,
  coordinateSystem,
  renderStack,
  layers,
  layerOrder,
  viewState,
  onViewStateChange,
  hostLayerResolver,
  onUnknownHostLayer,
  deckLayers: externalDeckLayers,
  deckProps,
  onHover,
  onClick,
  onFeatureHover,
  onFeatureClick,
  onShapeHover,
  onShapeClick,
  renderTooltip,
  tooltipContainer,
  showLoadingOverlay = true,
  autoFit = true,
  style,
  hoverTooltipMode = 'simple',
  vivImageExtensions,
  vivImageExtensionResolver,
  vivImagePropsResolver,
}: SpatialCanvasViewerProps) {
  const [measureRef, { width, height }] = useMeasure();
  const viewerContainerRef = useRef<HTMLDivElement | null>(null);
  const deckRef = useRef<DeckGLRef | null>(null);
  const { interacting, onInteractionStateChange } = useViewInteractionGate();
  // Shapes are pickable unless tooltips are off or the camera is being moved.
  const pickingEnabled = hoverTooltipMode !== 'off' && !interacting;
  const [hoverTooltip, setHoverTooltip] = useState<
    (SpatialFeatureTooltipData & { x: number; y: number; clientX: number; clientY: number }) | null
  >(null);

  const vw = width ?? 0;
  const vh = height ?? 0;
  const layerInputs = useMemo(() => {
    if (renderStack) {
      return renderStackToLayerInputs(renderStack);
    }
    return { layers: layers ?? {}, layerOrder: layerOrder ?? [] };
  }, [layerOrder, layers, renderStack]);
  const hostDeckLayers = useMemo(
    () => resolveRenderStackHostLayers(renderStack, hostLayerResolver, onUnknownHostLayer),
    [hostLayerResolver, onUnknownHostLayer, renderStack]
  );
  const resolvedLayerOrder = useMemo(
    () => renderStackOrder(renderStack, layerInputs.layerOrder),
    [layerInputs.layerOrder, renderStack]
  );
  const vivPassthrough = useMemo(
    (): VivImagePassthroughOptions => ({
      vivImageExtensions,
      vivImageExtensionResolver,
      vivImagePropsResolver,
    }),
    [vivImageExtensionResolver, vivImageExtensions, vivImagePropsResolver]
  );
  const renderer = useSpatialCanvasRendererFromLayerInputs({
    spatialData,
    coordinateSystem,
    layerInputs,
    renderOrder: resolvedLayerOrder,
    viewState,
    onViewStateChange,
    width: vw,
    height: vh,
    hostDeckLayers,
    externalDeckLayers,
    sortDeckLayers: Boolean(renderStack),
    autoFit,
    vivPassthrough,
    pickingEnabled,
  });
  const hoverPickLayerIds = useMemo(
    () => Array.from(renderer.enabledLayerIds),
    [renderer.enabledLayerIds]
  );
  // Feed deck's interaction state into the gate (via deckProps so the existing
  // spread reaches both DeckGL branches) while still invoking any caller-supplied
  // onInteractionStateChange handler.
  const mergedDeckProps = useMemo(() => {
    const callerOnInteractionStateChange = deckProps?.onInteractionStateChange;
    return {
      ...deckProps,
      onInteractionStateChange: (
        state: Parameters<NonNullable<DeckGLProps['onInteractionStateChange']>>[0]
      ) => {
        callerOnInteractionStateChange?.(state);
        onInteractionStateChange(state);
      },
    };
  }, [deckProps, onInteractionStateChange]);

  // The expensive part of hovering: aggregate-pick the feature(s) under the
  // cursor and position the tooltip. Throttled to one run per animation frame.
  const resolveTooltip = useCallback(
    (info: PickingInfo) => {
      if (hoverTooltipMode === 'off' || !shouldRenderInternalTooltip(renderTooltip)) {
        setHoverTooltip(null);
        return;
      }
      const tooltip =
        info.picked && typeof info.x === 'number' && typeof info.y === 'number'
          ? resolveHoverFeatureTooltip(info, renderer.getFeatureTooltip, {
              aggregate: hoverTooltipMode === 'aggregate',
              deck: getDeckFromDeckGlRef(deckRef),
              pickLayerIds: hoverPickLayerIds,
            })
          : null;
      // Resolve viewport coordinates here (in the event handler) rather than
      // reading the container ref during render.
      if (!tooltip) {
        setHoverTooltip(null);
        return;
      }
      const rect = viewerContainerRef.current?.getBoundingClientRect();
      setHoverTooltip({
        ...tooltip,
        clientX: (rect?.left ?? 0) + tooltip.x,
        clientY: (rect?.top ?? 0) + tooltip.y,
      });
    },
    [hoverTooltipMode, hoverPickLayerIds, renderTooltip, renderer.getFeatureTooltip]
  );

  const handleHover = useCallback(
    (info: PickingInfo, event?: HoverPointerEvent) => {
      onHover?.(info);
      // While panning/dragging, deck keeps firing hover events; the gesture is
      // changing the view, not inspecting features, so suppress tooltip work.
      if (isHoverDuringDrag(event)) {
        setHoverTooltip(null);
        return;
      }
      if (info.picked && typeof info.x === 'number' && typeof info.y === 'number') {
        const rawLayerId = typeof info.layer?.id === 'string' ? info.layer.id : '';
        const normalizedLayerId = rawLayerId.replace(/-#.*#$/, '');
        const featurePickEvent = renderer.getFeaturePickEvent(normalizedLayerId, {
          index: info.index,
          object: info.object,
        });
        if (featurePickEvent) {
          onFeatureHover?.({
            ...featurePickEvent,
            coordinateSystem,
            spatialData,
            pickInfo: info,
          });
        }
        const shapePickEvent = renderer.getShapePickEvent(normalizedLayerId, {
          index: info.index,
          object: info.object,
        });
        if (shapePickEvent) {
          onShapeHover?.({
            ...shapePickEvent,
            coordinateSystem,
            pickInfo: info,
          });
        }
      }
      resolveTooltip(info);
    },
    [coordinateSystem, onFeatureHover, onHover, onShapeHover, renderer, resolveTooltip, spatialData]
  );

  const handleClick = useCallback(
    (info: PickingInfo) => {
      onClick?.(info);
      if (!info.picked) {
        return;
      }
      const rawLayerId = typeof info.layer?.id === 'string' ? info.layer.id : '';
      const normalizedLayerId = rawLayerId.replace(/-#.*#$/, '');
      const featurePickEvent = renderer.getFeaturePickEvent(normalizedLayerId, {
        index: info.index,
        object: info.object,
      });
      if (featurePickEvent) {
        onFeatureClick?.({
          ...featurePickEvent,
          coordinateSystem,
          spatialData,
          pickInfo: info,
        });
      }
      const shapePickEvent = renderer.getShapePickEvent(normalizedLayerId, {
        index: info.index,
        object: info.object,
      });
      if (shapePickEvent) {
        onShapeClick?.({
          ...shapePickEvent,
          coordinateSystem,
          pickInfo: info,
        });
      }
    },
    [coordinateSystem, onClick, onFeatureClick, onShapeClick, renderer, spatialData]
  );

  const handleViewerRef = useCallback(
    (node: HTMLDivElement | null) => {
      viewerContainerRef.current = node;
      measureRef(node);
    },
    [measureRef]
  );

  const tooltipClientPosition = hoverTooltip
    ? { x: hoverTooltip.clientX, y: hoverTooltip.clientY }
    : null;

  const tooltipPayload: SpatialFeatureTooltipData | null = hoverTooltip;

  const portalTarget = typeof document !== 'undefined' ? (tooltipContainer ?? document.body) : null;
  const tooltipPortal =
    hoverTooltipMode !== 'off' &&
    shouldRenderInternalTooltip(renderTooltip) &&
    tooltipPayload &&
    tooltipClientPosition &&
    portalTarget &&
    createPortal(
      renderTooltip ? (
        renderTooltip({
          clientX: tooltipClientPosition.x,
          clientY: tooltipClientPosition.y,
          tooltip: tooltipPayload,
        })
      ) : (
        <SpatialFeatureTooltip
          x={tooltipClientPosition.x}
          y={tooltipClientPosition.y}
          tooltip={tooltipPayload}
          position="fixed"
        />
      ),
      portalTarget
    );

  const getLayerLoadStateByElementKey = useCallback(
    (elementKey: string) => {
      for (const layerId of layerInputs.layerOrder) {
        const layer = layerInputs.layers[layerId];
        if (layer?.type === 'image' && layer.elementKey === elementKey) {
          return renderer.getLayerLoadState(layerId);
        }
      }
      return undefined;
    },
    [layerInputs.layerOrder, layerInputs.layers, renderer]
  );

  return (
    <ImageLayerContextProvider
      getImageLoadedDataByElementKey={renderer.getImageLoadedDataByElementKey}
      getLayerLoadStateByElementKey={getLayerLoadStateByElementKey}
    >
      <div ref={handleViewerRef} style={{ ...viewerRootStyle, ...style }}>
        {!spatialData && !renderer.hasRenderableInputs ? (
          <div style={placeholderStyle}>No spatial data available</div>
        ) : !renderer.hasRenderableInputs ? (
          <div style={placeholderStyle}>
            {coordinateSystem ? 'No layers to display' : 'No coordinate system selected'}
          </div>
        ) : viewState === null && renderer.hasEnabledLayers ? (
          <div style={placeholderStyle}>
            {renderer.isBlocking ? 'Loading layer data...' : 'Framing view...'}
          </div>
        ) : (
          <>
            <SpatialViewer
              width={vw}
              height={vh}
              viewState={viewState}
              onViewStateChange={onViewStateChange}
              layers={renderer.deckLayers}
              layerOrder={renderer.layerOrder}
              vivLayerProps={renderer.vivLayerProps.length > 0 ? renderer.vivLayerProps : undefined}
              onHover={hoverTooltipMode === 'off' ? undefined : handleHover}
              onClick={handleClick}
              deckProps={mergedDeckProps}
              deckRef={deckRef}
            />
            {showLoadingOverlay && renderer.isBlocking && (
              <div style={overlayStyle}>Loading layer data...</div>
            )}
            {showLoadingOverlay && renderer.isLoading && !renderer.isBlocking && (
              <div style={{ ...overlayStyle, backgroundColor: 'rgba(20,20,20,0.78)' }}>
                Refreshing layer metadata...
              </div>
            )}
            {!renderer.hasLayersDrawn && !renderer.isBlocking && (
              <div style={{ ...placeholderStyle, position: 'absolute', inset: 0 }}>
                No layers to display
              </div>
            )}
          </>
        )}
      </div>
      {tooltipPortal}
    </ImageLayerContextProvider>
  );
}

export function SpatialCanvasViewer(props: SpatialCanvasViewerProps) {
  return (
    <VivLoaderRegistryProvider>
      <SpatialCanvasViewerInner {...props} />
    </VivLoaderRegistryProvider>
  );
}

export default SpatialCanvasViewer;
