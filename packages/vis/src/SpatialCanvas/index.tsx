/**
 * SpatialCanvas - A UI-driven component for composing spatial layers
 *
 * Provides a complete interface for:
 * - Selecting a coordinate system
 * - Choosing which elements to display
 * - Viewing overlaid spatial data with pan/zoom
 */

import { viewStateFromBounds } from '@spatialdata/core';
import { useSpatialData } from '@spatialdata/react';
import { useMeasure } from '@uidotdev/usehooks';
import type { DeckGLRef, Layer, PickingInfo } from 'deck.gl';
import {
  type CSSProperties,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { SpatialCanvasProvider, useSpatialCanvasActions, useSpatialCanvasStore } from './context';
import { type HoverPointerEvent, isHoverDuringDrag } from './featureTooltipHover';
import { ImageChannelPanelFromStore } from './ImageChannelPanel';
import { LabelsChannelPanel } from './LabelsChannelPanel';
import { LayerOrderList } from './LayerOrderList';
import { layerConfig } from './layerConfig';
import PointsLayerPanel from './PointsLayerPanel';
import { ShapeFillColorPanel } from './ShapeFillColorPanel';
import {
  DEFAULT_HOVER_TOOLTIP_MODE,
  type HoverTooltipMode,
  isHoverTooltipMode,
  shouldAutoFitSpatialView,
  useSpatialCanvasRendererFromLayerInputs,
} from './SpatialCanvasViewer';
import type { SpatialCanvasTooltipRenderProps } from './SpatialFeatureTooltip';
import { SpatialViewer } from './SpatialViewer';
import type { SpatialCanvasStoreApi } from './stores';
import { TooltipFieldsPanel } from './TooltipFieldsPanel';
import type { AvailableElement, ElementsByType, ViewState } from './types';
import { useHoverFeatureTooltip } from './useHoverFeatureTooltip';
import type { ImageLayerConfig } from './useLayerData';
import { generateLayerId, getAllCoordinateSystems } from './utils';
import { VivLoaderRegistryProvider } from './VivLoaderRegistry';

// ============================================
// Styles
// ============================================

const containerStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  height: '100%',
  minHeight: '400px',
  border: '1px solid #333',
  borderRadius: 8,
  overflow: 'hidden',
  backgroundColor: '#1a1a1a',
};

const controlsStyle: CSSProperties = {
  padding: '12px',
  borderBottom: '1px solid #333',
  backgroundColor: '#252525',
  display: 'flex',
  flexDirection: 'column',
  gap: '8px',
};

const rowStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: '12px',
};

const labelStyle: CSSProperties = {
  color: '#999',
  fontSize: '12px',
  minWidth: '100px',
};

const selectStyle: CSSProperties = {
  backgroundColor: '#333',
  color: '#fff',
  border: '1px solid #444',
  borderRadius: 4,
  padding: '4px 8px',
  fontSize: '13px',
};

const layerListStyle: CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  gap: '8px',
};

const layerChipStyle = (active: boolean): CSSProperties => ({
  padding: '4px 10px',
  borderRadius: 4,
  fontSize: '12px',
  cursor: 'pointer',
  border: active ? '1px solid #4a9eff' : '1px solid #444',
  backgroundColor: active ? '#2a4a6a' : '#333',
  color: active ? '#fff' : '#aaa',
  transition: 'all 0.15s ease',
});

const viewerContainerStyle: CSSProperties = {
  flex: 1,
  position: 'relative',
  overflow: 'hidden',
  minWidth: 0,
  minHeight: 0,
};

const mainRowStyle: CSSProperties = {
  flex: 1,
  display: 'flex',
  flexDirection: 'row',
  minHeight: 0,
};

const sidebarStyle: CSSProperties = {
  flexShrink: 0,
  overflow: 'auto',
  padding: 10,
  backgroundColor: '#1e1e1e',
};

const fullscreenOverlayStyle: CSSProperties = {
  position: 'fixed',
  inset: 0,
  zIndex: 10000,
  backgroundColor: '#1a1a1a',
};

const placeholderStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  height: '100%',
  color: '#666',
  fontSize: '14px',
};

// ============================================
// Layer Selector Component
// ============================================

interface LayerSelectorProps {
  elements: ElementsByType;
  enabledLayerIds: Set<string>;
  onToggleLayer: (element: AvailableElement) => void;
}

function LayerSelector({ elements, enabledLayerIds, onToggleLayer }: LayerSelectorProps) {
  const elementTypes = ['images', 'shapes', 'points', 'labels'] as const;
  const typeLabels: Record<(typeof elementTypes)[number], string> = {
    images: 'Images',
    shapes: 'Shapes',
    points: 'Points',
    labels: 'Labels',
  };

  return (
    <>
      {elementTypes.map((type) => {
        const typeElements = elements[type];
        if (typeElements.length === 0) return null;

        return (
          <div key={type} style={rowStyle}>
            <span style={labelStyle}>{typeLabels[type]}:</span>
            <div style={layerListStyle}>
              {typeElements.map((elem) => {
                const layerId = generateLayerId(elem.type, elem.key);
                const isActive = enabledLayerIds.has(layerId);
                return (
                  <button
                    key={elem.key}
                    type="button"
                    style={layerChipStyle(isActive)}
                    onClick={() => onToggleLayer(elem)}
                  >
                    {elem.key}
                  </button>
                );
              })}
            </div>
          </div>
        );
      })}
    </>
  );
}

// ============================================
// Viewer section — subscribes to viewState only
// ============================================

/**
 * Isolated sub-component that is the sole subscriber to `viewState` from the
 * Zustand store.  By confining the viewState subscription here, pan events only
 * cause this lightweight wrapper and `SpatialViewer` to re-render; the heavier
 * `SpatialCanvasInner` (sidebars, layer list, renderer hook) stays untouched.
 */
interface ViewerSectionProps {
  deckLayers: Layer[];
  layerOrder: string[];
  vivLayerProps: ImageLayerConfig[];
  hasEnabledLayers: boolean;
  isBlocking: boolean;
  isLoading: boolean;
  hasLayersDrawn: boolean;
  getWorldBoundsForVisibleLayers: () => import('@spatialdata/core').AxisAlignedBounds | null;
  vw: number;
  vh: number;
  onHover?: (info: PickingInfo, event?: HoverPointerEvent) => void;
  coordinateSystem: string | null;
  deckRef: React.RefObject<DeckGLRef | null>;
}

function ViewerSection({
  deckLayers,
  layerOrder,
  vivLayerProps,
  hasEnabledLayers,
  isBlocking,
  isLoading,
  hasLayersDrawn,
  getWorldBoundsForVisibleLayers,
  vw,
  vh,
  onHover,
  coordinateSystem,
  deckRef,
}: ViewerSectionProps) {
  const viewState = useSpatialCanvasStore((s) => s.viewState);
  const actions = useSpatialCanvasActions();

  const handleViewStateChange = useCallback(
    (vs: ViewState) => {
      actions.setViewState(vs);
    },
    [actions]
  );

  // Auto-fit: fires once when viewState is null and layers become renderable.
  useEffect(() => {
    if (
      !shouldAutoFitSpatialView({
        autoFit: true,
        hasEnabledLayers,
        width: vw,
        height: vh,
        isBlocking,
        viewState,
      })
    ) {
      return;
    }
    const bounds = getWorldBoundsForVisibleLayers();
    handleViewStateChange(
      bounds ? viewStateFromBounds(bounds, vw, vh) : { target: [0, 0], zoom: 0 }
    );
  }, [
    hasEnabledLayers,
    vh,
    vw,
    isBlocking,
    getWorldBoundsForVisibleLayers,
    handleViewStateChange,
    viewState,
  ]);

  if (!hasEnabledLayers) {
    return (
      <div style={placeholderStyle}>
        {coordinateSystem ? 'Select layers to display' : 'Select a coordinate system'}
      </div>
    );
  }

  if (viewState === null) {
    return (
      <div style={placeholderStyle}>{isBlocking ? 'Loading layer data...' : 'Framing view...'}</div>
    );
  }

  return (
    <div style={{ width: vw, height: vh, position: 'relative' }}>
      <SpatialViewer
        width={vw}
        height={vh}
        viewState={viewState}
        onViewStateChange={handleViewStateChange}
        layers={deckLayers}
        layerOrder={layerOrder}
        vivLayerProps={vivLayerProps.length > 0 ? vivLayerProps : undefined}
        onHover={onHover}
        deckRef={deckRef}
      />
      {isBlocking && (
        <div
          style={{
            position: 'absolute',
            top: 8,
            right: 8,
            padding: '4px 8px',
            backgroundColor: 'rgba(0,0,0,0.7)',
            color: '#fff',
            fontSize: '11px',
            borderRadius: 4,
          }}
        >
          Loading layer data...
        </div>
      )}
      {isLoading && !isBlocking && (
        <div
          style={{
            position: 'absolute',
            top: 8,
            right: 8,
            padding: '4px 8px',
            backgroundColor: 'rgba(20,20,20,0.78)',
            color: '#d5d5d5',
            fontSize: '11px',
            borderRadius: 4,
          }}
        >
          Refreshing layer metadata...
        </div>
      )}
      {!hasLayersDrawn && !isBlocking && (
        <div
          style={{
            position: 'absolute',
            top: '50%',
            left: '50%',
            transform: 'translate(-50%, -50%)',
            color: '#666',
            fontSize: '13px',
          }}
        >
          No layers to display
        </div>
      )}
    </div>
  );
}

// ============================================
// Inner Canvas (connected to store)
// ============================================

interface SpatialCanvasInnerProps {
  /** Portal mount node for picked-feature hover tooltips; defaults to `document.body`. */
  tooltipContainer?: HTMLElement | null;
  /** Override default tooltip UI; receives pick position in viewport coordinates. */
  renderTooltip?: (props: SpatialCanvasTooltipRenderProps) => ReactNode;
  /**
   * Initial hover tooltip mode (`'off'` | `'simple'` | `'aggregate'`). The UI
   * exposes a selector to change it live; this sets the starting value.
   */
  hoverTooltipMode?: HoverTooltipMode;
}

function SpatialCanvasInner({
  tooltipContainer,
  renderTooltip,
  hoverTooltipMode = DEFAULT_HOVER_TOOLTIP_MODE,
}: SpatialCanvasInnerProps) {
  // Points reactivity now lives in <PointsFeatureStateProvider> (the panel
  // subscribes to the engine via useSyncExternalStore), so this component no
  // longer reads mutable engine state through stable getters and doesn't need a
  // React Compiler escape hatch. Deck-layer updates still flow through the
  // renderer result (a fresh array on each rebuild — a tracked dependency).
  const { spatialData, loading: sdLoading } = useSpatialData();
  const [tooltipMode, setTooltipMode] = useState<HoverTooltipMode>(hoverTooltipMode);
  const [measureRef, { width, height }] = useMeasure();
  const shellRef = useRef<HTMLDivElement | null>(null);
  const deckRef = useRef<DeckGLRef | null>(null);
  const [fullscreen, setFullscreen] = useState(false);
  // A one-shot request to refit the view after a fullscreen toggle changes the
  // container size. Stored in a ref (not state) so consuming it in the resize
  // effect doesn't require a setState-in-effect.
  const pendingFullscreenRefitSizeRef = useRef<{
    width: number;
    height: number;
  } | null>(null);

  const coordinateSystem = useSpatialCanvasStore((s) => s.coordinateSystem);
  const layers = useSpatialCanvasStore((s) => s.layers);
  const layerOrder = useSpatialCanvasStore((s) => s.layerOrder);
  // viewState is intentionally NOT subscribed here.  It is consumed only by
  // ViewerSection, which is the sole component that re-renders on every pan.
  const selectedLayerId = useSpatialCanvasStore((s) => s.selectedLayerId);

  const actions = useSpatialCanvasActions();

  const coordinateSystems = useMemo(() => {
    if (!spatialData) return [];
    return getAllCoordinateSystems(spatialData);
  }, [spatialData]);

  const vw = width ?? 0;
  const vh = height ?? 0;
  // Shapes are pickable whenever hover tooltips are on. Picking stays live through
  // pan/zoom: the FlatPolygonLayer picking pass is a single vertex-pulled draw, so
  // the old "suppress picking during camera moves" gate is no longer needed.
  const pickingEnabled = tooltipMode !== 'off';

  // keeping a big bundle of these to pass into child components
  // (may not be a good idea).
  const rendererProps = useSpatialCanvasRendererFromLayerInputs({
    spatialData,
    coordinateSystem,
    layerInputs: { layers, layerOrder },
    // viewState and onViewStateChange are omitted: auto-fit and pan handling
    // are managed entirely by ViewerSection so this hook never re-runs on pan.
    width: vw,
    height: vh,
    pickingEnabled,
  });

  const {
    availableElements,
    deckLayers,
    enabledLayerIds,
    getFeatureTooltip,
    getImageLayerLoadedData,
    getLabelsLayerLoadedData,
    getLayerLoadState,
    getWorldBoundsForLayer,
    getWorldBoundsForVisibleLayers,
    hasEnabledLayers,
    hasLayersDrawn,
    hasRenderableLayerData,
    isBlocking,
    isLoading,
    pointsEngine,
    resolvePointsTarget,
    vivLayerProps,
  } = rendererProps;
  const hoverPickLayerIds = useMemo(() => Array.from(enabledLayerIds), [enabledLayerIds]);

  // Shared hover-tooltip machinery (pick → tooltip → portal); see
  // useHoverFeatureTooltip. `handleHover` below stays local (the drag guard).
  const { containerRef, resolveTooltip, clearTooltip, tooltipPortal } = useHoverFeatureTooltip({
    enabled: tooltipMode !== 'off',
    aggregate: tooltipMode === 'aggregate',
    getFeatureTooltip,
    hoverPickLayerIds,
    deckRef,
    renderTooltip,
    tooltipContainer,
  });

  useEffect(() => {
    const pending = pendingFullscreenRefitSizeRef.current;
    if (
      !pending ||
      !hasEnabledLayers ||
      vw <= 0 ||
      vh <= 0 ||
      isBlocking ||
      (vw === pending.width && vh === pending.height)
    ) {
      return;
    }

    const bounds = getWorldBoundsForVisibleLayers();
    const next = bounds
      ? viewStateFromBounds(bounds, vw, vh)
      : { target: [0, 0] as [number, number], zoom: 0 };
    actions.setViewState(next);
    pendingFullscreenRefitSizeRef.current = null;
  }, [actions, getWorldBoundsForVisibleLayers, hasEnabledLayers, isBlocking, vh, vw]);

  useEffect(() => {
    actions.reset();
    const nextCoordinateSystem =
      coordinateSystem && coordinateSystems.includes(coordinateSystem)
        ? coordinateSystem
        : coordinateSystems.length === 1
          ? coordinateSystems[0]
          : null;
    if (nextCoordinateSystem) {
      actions.setCoordinateSystem(nextCoordinateSystem);
    }
  }, [coordinateSystem, coordinateSystems, actions]);

  useEffect(() => {
    if (selectedLayerId && !layerOrder.includes(selectedLayerId)) {
      actions.setSelectedLayerId(layerOrder[layerOrder.length - 1] ?? null);
    }
  }, [layerOrder, selectedLayerId, actions]);

  const handleCSChange = useCallback(
    (e: React.ChangeEvent<HTMLSelectElement>) => {
      actions.setCoordinateSystem(e.target.value || null);
    },
    [actions]
  );

  const handleToggleLayer = useCallback(
    (element: AvailableElement) => {
      const layerId = generateLayerId(element.type, element.key);
      const existing = layers[layerId];

      if (existing) {
        actions.toggleLayerVisibility(layerId);
      } else {
        const config = layerConfig(element.type, {
          id: layerId,
          elementKey: element.key,
          visible: true,
          opacity: 1,
        });
        actions.addLayer(config);
      }
    },
    [layers, actions]
  );

  const selectedConfig = selectedLayerId ? layers[selectedLayerId] : undefined;
  const associatedTable =
    selectedConfig?.type === 'shapes'
      ? spatialData?.getAssociatedTable('shapes', selectedConfig.elementKey)?.[1]
      : selectedConfig?.type === 'labels'
        ? spatialData?.getAssociatedTable('labels', selectedConfig.elementKey)?.[1]
        : undefined;
  const selectedLayerLoadState = getLayerLoadState(selectedConfig?.id);

  // The resource whose readiness means the layer has centerable geometry:
  // image/labels are raster (image status); shapes/points are geometry.
  const selectedLayerReadyResource =
    selectedConfig?.type === 'image' || selectedConfig?.type === 'labels'
      ? selectedLayerLoadState?.image
      : selectedLayerLoadState?.geometry;

  const selectedLayerCanCenter =
    !!selectedConfig?.id &&
    selectedConfig.visible &&
    vw > 0 &&
    vh > 0 &&
    // Gate on the reactive load-state (not just `hasRenderableLayerData`, which
    // reads an imperatively-mutated ref cache): a ref mutation does not trigger a
    // re-render, so relying on it alone leaves this button stale-disabled until an
    // unrelated re-render recomputes it. `selectedLayerLoadState` is real state and
    // flips to 'ready' in lockstep with the load, so the button enables immediately.
    (selectedLayerReadyResource === 'ready' || hasRenderableLayerData(selectedConfig.id));

  // TODO: include extra annotation columns carried by the shapes element itself,
  // not just associated table obs columns. Longer term, expose entries
  // corresponding to vars in X / layers once core has a clean annotation API.
  const availableTooltipFields =
    associatedTable?.getObsColumnNames().filter((columnName) => {
      const tableKeys = associatedTable.getTableKeys();
      return columnName !== tableKeys.instanceKey && columnName !== tableKeys.regionKey;
    }) ?? [];

  // The expensive part of hovering: aggregate-pick the feature(s) under the
  // cursor and position the tooltip. Throttled to one run per animation frame.
  const handleHover = useCallback(
    (info: PickingInfo, event?: HoverPointerEvent) => {
      // While panning/dragging, deck keeps firing hover events; the gesture is
      // changing the view, not inspecting features, so suppress tooltip work.
      if (isHoverDuringDrag(event)) {
        clearTooltip();
        return;
      }
      resolveTooltip(info);
    },
    [resolveTooltip, clearTooltip]
  );

  const handleViewerRef = useCallback(
    (node: HTMLDivElement | null) => {
      containerRef.current = node;
      measureRef(node);
    },
    [measureRef, containerRef]
  );

  const handleCenterOnSelectedLayer = useCallback(() => {
    if (!selectedLayerCanCenter || !selectedLayerId) return;
    const config = layers[selectedLayerId];
    if (!config) return;
    const b = getWorldBoundsForLayer(config.id);
    if (!b) return;
    actions.setViewState(viewStateFromBounds(b, vw, vh));
  }, [selectedLayerCanCenter, selectedLayerId, layers, getWorldBoundsForLayer, actions, vw, vh]);

  if (sdLoading) {
    return (
      <div style={containerStyle}>
        <div style={placeholderStyle}>Loading spatial data...</div>
      </div>
    );
  }

  if (!spatialData) {
    return (
      <div style={containerStyle}>
        <div style={placeholderStyle}>No spatial data available</div>
      </div>
    );
  }

  const hasElements = Object.values(availableElements).some((arr) => arr.length > 0);

  const shellStyle: CSSProperties = fullscreen
    ? { ...containerStyle, ...fullscreenOverlayStyle, position: 'fixed' }
    : { ...containerStyle, position: 'relative' };

  return (
    <>
      <div ref={shellRef} style={shellStyle}>
        <div style={controlsStyle}>
          <div style={{ ...rowStyle, flexWrap: 'wrap' }}>
            <span style={labelStyle}>Coordinate System:</span>
            <select style={selectStyle} value={coordinateSystem || ''} onChange={handleCSChange}>
              <option value="">Select...</option>
              {coordinateSystems.map((cs) => (
                <option key={cs} value={cs}>
                  {cs}
                </option>
              ))}
            </select>
            <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <span style={{ color: '#999', fontSize: '12px' }}>Tooltips:</span>
              <select
                style={selectStyle}
                value={tooltipMode}
                onChange={(e) => {
                  if (isHoverTooltipMode(e.target.value)) setTooltipMode(e.target.value);
                }}
                title="Off disables shape picking entirely (fastest); Aggregate picks all layers under the cursor (slowest)."
              >
                <option value="off">Off</option>
                <option value="simple">Simple</option>
                <option value="aggregate">Aggregate</option>
              </select>
            </label>
            <button
              type="button"
              style={{ ...selectStyle, marginLeft: 'auto', cursor: 'pointer' }}
              onClick={() => {
                pendingFullscreenRefitSizeRef.current = { width: vw, height: vh };
                setFullscreen((f) => !f);
              }}
            >
              {fullscreen ? 'Exit fullscreen' : 'Fullscreen'}
            </button>
          </div>

          {coordinateSystem && hasElements && (
            <LayerSelector
              elements={availableElements}
              enabledLayerIds={enabledLayerIds}
              onToggleLayer={handleToggleLayer}
            />
          )}

          {coordinateSystem && !hasElements && (
            <div style={{ color: '#666', fontSize: '12px' }}>
              No elements available in this coordinate system
            </div>
          )}
        </div>

        <div style={mainRowStyle}>
          <aside style={{ ...sidebarStyle, width: 220, borderRight: '1px solid #333' }}>
            <div style={{ color: '#aaa', fontSize: '12px', marginBottom: 8, fontWeight: 600 }}>
              Layers
            </div>
            <LayerOrderList
              layerOrder={layerOrder}
              layers={layers}
              selectedLayerId={selectedLayerId}
              onSelect={actions.setSelectedLayerId}
              reorderLayers={actions.reorderLayers}
            />
          </aside>

          <div ref={handleViewerRef} style={viewerContainerStyle}>
            <ViewerSection
              deckLayers={deckLayers}
              layerOrder={layerOrder}
              vivLayerProps={vivLayerProps}
              hasEnabledLayers={hasEnabledLayers}
              isBlocking={isBlocking}
              isLoading={isLoading}
              hasLayersDrawn={hasLayersDrawn}
              getWorldBoundsForVisibleLayers={getWorldBoundsForVisibleLayers}
              vw={vw}
              vh={vh}
              onHover={tooltipMode === 'off' ? undefined : handleHover}
              coordinateSystem={coordinateSystem}
              deckRef={deckRef}
            />
          </div>

          <aside style={{ ...sidebarStyle, width: 300, borderLeft: '1px solid #333' }}>
            <div style={{ color: '#aaa', fontSize: '12px', marginBottom: 8, fontWeight: 600 }}>
              Properties
            </div>
            {!selectedConfig && (
              <div style={{ color: '#666', fontSize: '12px' }}>Select a layer in the list</div>
            )}
            {selectedConfig && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                <div>
                  <span style={labelStyle}>Element</span>
                  <div style={{ color: '#ddd', fontSize: '13px' }}>{selectedConfig.elementKey}</div>
                  <div style={{ color: '#888', fontSize: '11px' }}>{selectedConfig.type}</div>
                </div>
                <label
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                    color: '#ccc',
                    fontSize: '12px',
                  }}
                >
                  <input
                    type="checkbox"
                    checked={selectedConfig.visible}
                    onChange={() => actions.toggleLayerVisibility(selectedConfig.id)}
                  />
                  Visible
                </label>
                <button
                  type="button"
                  style={{
                    ...selectStyle,
                    cursor: selectedLayerCanCenter ? 'pointer' : 'not-allowed',
                    opacity: selectedLayerCanCenter ? 1 : 0.5,
                  }}
                  disabled={!selectedLayerCanCenter}
                  onClick={handleCenterOnSelectedLayer}
                >
                  Center on layer
                </button>
                <label
                  style={{
                    color: '#ccc',
                    fontSize: '12px',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 4,
                  }}
                >
                  Opacity
                  <input
                    type="range"
                    min={0}
                    max={1}
                    step={0.01}
                    value={selectedConfig.opacity}
                    onChange={(e) =>
                      actions.updateLayer(selectedConfig.id, { opacity: Number(e.target.value) })
                    }
                  />
                </label>
                {selectedConfig.type === 'points' && (
                  <label
                    style={{
                      color: '#ccc',
                      fontSize: '12px',
                      display: 'flex',
                      flexDirection: 'column',
                      gap: 4,
                    }}
                  >
                    Point size ({(selectedConfig.pointSize ?? 1).toFixed(1)})
                    <input
                      type="range"
                      min={0.1}
                      max={12}
                      step={0.1}
                      value={selectedConfig.pointSize ?? 1}
                      onChange={(e) =>
                        actions.updateLayer(selectedConfig.id, {
                          pointSize: Number(e.target.value),
                        })
                      }
                    />
                  </label>
                )}
                {selectedConfig.type === 'points' && (
                  <PointsLayerPanel
                    config={selectedConfig}
                    engine={pointsEngine}
                    resolveTarget={resolvePointsTarget}
                  />
                )}
                {selectedLayerLoadState && (
                  <div
                    style={{
                      display: 'flex',
                      flexDirection: 'column',
                      gap: 4,
                      color: '#888',
                      fontSize: '11px',
                    }}
                  >
                    {selectedConfig.type !== 'image' && selectedLayerLoadState.geometry && (
                      <div>
                        Geometry: {selectedLayerLoadState.geometry}
                        {!hasRenderableLayerData(selectedConfig.id) &&
                        selectedLayerLoadState.geometry === 'loading'
                          ? // Points decode on a worker (off the main thread); other
                            // geometry decodes on the main thread and blocks first paint.
                            selectedConfig.type === 'points'
                            ? ' (worker)'
                            : ' (blocking)'
                          : ''}
                      </div>
                    )}
                    {(selectedConfig.type === 'image' || selectedConfig.type === 'labels') &&
                      selectedLayerLoadState.image && (
                        <div>
                          {selectedConfig.type === 'labels' ? 'Labels' : 'Image'}:{' '}
                          {selectedLayerLoadState.image}
                          {!hasRenderableLayerData(selectedConfig.id) &&
                          selectedLayerLoadState.image === 'loading'
                            ? ' (blocking)'
                            : ''}
                        </div>
                      )}
                    {(selectedConfig.type === 'shapes' || selectedConfig.type === 'labels') &&
                      selectedLayerLoadState.tooltip && (
                        <div>Tooltip metadata: {selectedLayerLoadState.tooltip}</div>
                      )}
                  </div>
                )}
                {selectedConfig.type === 'image' && (
                  <ImageChannelPanelFromStore
                    layerId={selectedConfig.id}
                    config={selectedConfig}
                    defaults={getImageLayerLoadedData(selectedConfig.id)}
                    updateLayer={actions.updateLayer}
                  />
                )}
                {selectedConfig.type === 'labels' && (
                  <LabelsChannelPanel
                    layerId={selectedConfig.id}
                    config={selectedConfig}
                    defaults={getLabelsLayerLoadedData(selectedConfig.id)}
                    updateLayer={actions.updateLayer}
                  />
                )}
                {selectedConfig.type === 'shapes' && (
                  <ShapeFillColorPanel
                    tableName={associatedTable?.key}
                    availableFields={availableTooltipFields}
                    selected={selectedConfig.fillColorByColumn}
                    onChange={(fillColorByColumn) => {
                      actions.updateLayer(selectedConfig.id, { fillColorByColumn });
                    }}
                    noAssociatedTableMessage="No associated table found for this shapes layer"
                  />
                )}
                {(selectedConfig.type === 'shapes' || selectedConfig.type === 'labels') && (
                  <TooltipFieldsPanel
                    tableName={associatedTable?.key}
                    availableFields={availableTooltipFields}
                    selectedFields={selectedConfig.tooltipFields ?? []}
                    onChange={(tooltipFields) => {
                      actions.updateLayer(selectedConfig.id, { tooltipFields });
                    }}
                    helperText={
                      selectedConfig.type === 'labels'
                        ? 'Picked label ids are always shown; selected fields are appended from the associated table.'
                        : undefined
                    }
                    noAssociatedTableMessage={
                      selectedConfig.type === 'labels'
                        ? 'No associated table found for this labels layer. Hover will show the picked label id only.'
                        : 'No associated table found for this shapes layer'
                    }
                  />
                )}
              </div>
            )}
          </aside>
        </div>
      </div>
      {tooltipPortal}
    </>
  );
}

// ============================================
// Main Export
// ============================================

export interface SpatialCanvasProps {
  /**
   * Optional external store for state management.
   * If not provided, an internal store will be created.
   */
  store?: SpatialCanvasStoreApi;
  /**
   * DOM node to mount picked-feature hover tooltips (React portal target).
   * Defaults to `document.body` when omitted.
   */
  tooltipContainer?: HTMLElement | null;
  /**
   * Custom tooltip UI for picked-feature hovers. Receives viewport coordinates
   * and the library-built payload; omit to use the default `SpatialFeatureTooltip`
   * styling.
   */
  renderTooltip?: (props: SpatialCanvasTooltipRenderProps) => ReactNode;
  /**
   * Initial hover tooltip mode: `'off'` | `'simple'` | `'aggregate'` (default).
   * The canvas UI exposes a selector to change it live. See {@link HoverTooltipMode}.
   */
  hoverTooltipMode?: HoverTooltipMode;
}

/**
 * SpatialCanvas provides a complete UI for viewing and composing spatial data layers.
 *
 * It uses SpatialData from the nearest SpatialDataProvider context and allows users to:
 * - Select a coordinate system
 * - Toggle visibility of elements that can be displayed in that coordinate system
 * - Pan and zoom the view
 * - View images, shapes, points, and labels(tbd) together
 *
 * @example Basic usage
 * ```tsx
 * <SpatialDataProvider source="https://example.com/data.zarr">
 *   <SpatialCanvas />
 * </SpatialDataProvider>
 * ```
 *
 * @example With external store (for MDV integration)
 * ```tsx
 * const store = createSpatialCanvasStore();
 *
 * <SpatialDataProvider source="...">
 *   <SpatialCanvas store={store} />
 * </SpatialDataProvider>
 *
 * // Store can also be accessed externally
 * store.getState().setCoordinateSystem('global');
 * ```
 *
 * @example With image layer channel controls (advanced API)
 * ```tsx
 * const store = createSpatialCanvasStore();
 *
 * // Add image layer with custom channel configuration
 * store.getState().addLayer({
 *   id: 'image:my_image',
 *   type: 'image',
 *   elementKey: 'my_image',
 *   visible: true,
 *   opacity: 1,
 *   channels: {
 *     colors: [[255, 0, 0], [0, 255, 0]],
 *     contrastLimits: [[0, 1000], [0, 2000]],
 *     channelsVisible: [true, true],
 *     selections: [{ z: 0, c: 0, t: 0 }],
 *   },
 * });
 * ```
 */
export default function SpatialCanvas({
  store,
  tooltipContainer,
  renderTooltip,
  hoverTooltipMode,
}: SpatialCanvasProps) {
  return (
    <VivLoaderRegistryProvider>
      <SpatialCanvasProvider store={store}>
        <SpatialCanvasInner
          tooltipContainer={tooltipContainer}
          renderTooltip={renderTooltip}
          hoverTooltipMode={hoverTooltipMode}
        />
      </SpatialCanvasProvider>
    </VivLoaderRegistryProvider>
  );
}
