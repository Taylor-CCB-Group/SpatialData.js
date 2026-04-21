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
import type { PickingInfo } from 'deck.gl';
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
import { ImageChannelPanel } from './ImageChannelPanel';
import { LayerOrderList } from './LayerOrderList';
import { LabelsChannelPanel } from './LabelsChannelPanel';
import { TooltipFieldsPanel } from './TooltipFieldsPanel';
import {
  type SpatialCanvasTooltipRenderProps,
  SpatialFeatureTooltip,
  type SpatialFeatureTooltipData,
} from './SpatialFeatureTooltip';
import { SpatialViewer } from './SpatialViewer';
import { VivLoaderRegistryProvider } from './VivLoaderRegistry';
import { SpatialCanvasProvider, useSpatialCanvasActions, useSpatialCanvasStore } from './context';
import type { SpatialCanvasStoreApi } from './stores';
import type { AvailableElement, ElementsByType, LayerConfig, ViewState } from './types';
import { useLayerData } from './useLayerData';
import { generateLayerId, getAllCoordinateSystems, getAvailableElements } from './utils';

export {
  SpatialFeatureTooltip,
  type SpatialFeatureTooltipData,
  type SpatialFeatureTooltipItem,
  type SpatialCanvasTooltipRenderProps,
  type SpatialFeatureTooltipProps,
} from './SpatialFeatureTooltip';

// Re-export for external use
export {
  SpatialCanvasProvider,
  useSpatialCanvasStore,
  useSpatialCanvasActions,
  useSpatialCanvasStoreApi,
} from './context';
export { createSpatialCanvasStore } from './stores';
export type { SpatialCanvasStoreApi } from './stores';
export type * from './types';
export { useSpatialViewState, useViewStateUrl } from './hooks';
export { VivSpatialViewer } from './VivSpatialViewer';
export type { ImageLayerConfig as VivImageLayerConfig } from './useLayerData';

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
// Inner Canvas (connected to store)
// ============================================

interface SpatialCanvasInnerProps {
  /** Portal mount node for picked-feature hover tooltips; defaults to `document.body`. */
  tooltipContainer?: HTMLElement | null;
  /** Override default tooltip UI; receives pick position in viewport coordinates. */
  renderTooltip?: (props: SpatialCanvasTooltipRenderProps) => ReactNode;
}

function SpatialCanvasInner({ tooltipContainer, renderTooltip }: SpatialCanvasInnerProps) {
  const { spatialData, loading: sdLoading } = useSpatialData();
  const [measureRef, { width, height }] = useMeasure();
  const shellRef = useRef<HTMLDivElement | null>(null);
  const viewerContainerRef = useRef<HTMLDivElement | null>(null);
  const [fullscreen, setFullscreen] = useState(false);
  const [hoverTooltip, setHoverTooltip] = useState<{
    x: number;
    y: number;
    title?: string;
    items: Array<{ label: string; value: string }>;
  } | null>(null);

  const coordinateSystem = useSpatialCanvasStore((s) => s.coordinateSystem);
  const layers = useSpatialCanvasStore((s) => s.layers);
  const layerOrder = useSpatialCanvasStore((s) => s.layerOrder);
  const viewState = useSpatialCanvasStore((s) => s.viewState);
  const selectedLayerId = useSpatialCanvasStore((s) => s.selectedLayerId);

  const actions = useSpatialCanvasActions();

  const coordinateSystems = useMemo(() => {
    if (!spatialData) return [];
    return getAllCoordinateSystems(spatialData);
  }, [spatialData]);

  const availableElements = useMemo(() => {
    if (!spatialData || !coordinateSystem) {
      return { images: [], shapes: [], points: [], labels: [] } satisfies ElementsByType;
    }
    return getAvailableElements(spatialData, coordinateSystem);
  }, [spatialData, coordinateSystem]);

  const {
    getLayers,
    getVivLayerProps,
    getImageLayerLoadedData,
    getLabelsLayerLoadedData,
    getLayerLoadState,
    hasRenderableLayerData,
    getFeatureTooltip,
    isLoading,
    isBlocking,
    getWorldBoundsForLayer,
    getWorldBoundsForVisibleLayers,
  } = useLayerData(
    layers,
    layerOrder,
    availableElements,
    coordinateSystem,
    spatialData ?? undefined
  );

  const deckLayers = getLayers();
  const vivLayerProps = getVivLayerProps();
  const handleViewStateChange = useCallback(
    (vs: ViewState) => {
      actions.setViewState(vs);
    },
    [actions]
  );

  const enabledLayerIds = useMemo(() => {
    return new Set(layerOrder.filter((id) => layers[id]?.visible));
  }, [layers, layerOrder]);

  const vw = width ?? 0;
  const vh = height ?? 0;
  const hasEnabledLayers = enabledLayerIds.size > 0;

  useEffect(() => {
    if (!hasEnabledLayers || vw <= 0 || vh <= 0 || isBlocking || viewState !== null) {
      return;
    }
    const bounds = getWorldBoundsForVisibleLayers();
    const next = bounds
      ? viewStateFromBounds(bounds, vw, vh)
      : { target: [0, 0] as [number, number], zoom: 0 };
    actions.setViewState(next);
  }, [hasEnabledLayers, vw, vh, isBlocking, viewState, getWorldBoundsForVisibleLayers, actions]);

  useEffect(() => {
    if (coordinateSystems.length > 0 && !coordinateSystem) {
      actions.setCoordinateSystem(coordinateSystems[0]);
    }
  }, [coordinateSystems, coordinateSystem, actions]);

  useEffect(() => {
    actions.reset();
    if (coordinateSystem && coordinateSystems.includes(coordinateSystem)) {
      actions.setCoordinateSystem(coordinateSystem);
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
        const config: LayerConfig = {
          id: layerId,
          type: element.type,
          elementKey: element.key,
          visible: true,
          opacity: 1,
        };
        actions.addLayer(config);
      }
    },
    [layers, actions]
  );

  const hasLayersDrawn = deckLayers.length > 0 || vivLayerProps.length > 0;
  const selectedConfig = selectedLayerId ? layers[selectedLayerId] : undefined;
  const associatedTable =
    selectedConfig?.type === 'shapes'
      ? spatialData?.getAssociatedTable('shapes', selectedConfig.elementKey)?.[1]
      : selectedConfig?.type === 'labels'
        ? spatialData?.getAssociatedTable('labels', selectedConfig.elementKey)?.[1]
        : undefined;
  const selectedLayerLoadState = getLayerLoadState(selectedConfig?.id);

  /** Avoid recomputing polygon/image bounds on every pan (viewState) — only when layer data / CS / selection changes. */
  const selectedLayerWorldBounds = useMemo(() => {
    const id = selectedConfig?.id;
    if (!id) return null;
    if (!hasRenderableLayerData(id)) return null;
    return getWorldBoundsForLayer(id);
  }, [
    selectedConfig?.id,
    selectedLayerLoadState,
    coordinateSystem,
    layerOrder,
    layers,
    availableElements,
    getWorldBoundsForLayer,
    hasRenderableLayerData,
  ]);

  // we probably want to see more than obs columns here... but I also don't understand what subset of those we end up with.
  // why not allow instanceKey & regionKey...
  const availableTooltipFields =
    associatedTable?.getObsColumnNames().filter((columnName) => {
      const tableKeys = associatedTable.getTableKeys();
      return columnName !== tableKeys.instanceKey && columnName !== tableKeys.regionKey;
    }) ?? [];

  const handleHover = useCallback(
    (info: PickingInfo) => {
      if (!info.picked || typeof info.x !== 'number' || typeof info.y !== 'number') {
        setHoverTooltip(null);
        return;
      }
      const rawLayerId = typeof info.layer?.id === 'string' ? info.layer.id : '';
      const normalizedLayerId = rawLayerId.replace(/-#.*#$/, '');
      const tooltip = getFeatureTooltip(normalizedLayerId, {
        index: info.index,
        object: info.object,
      });
      if (!tooltip) {
        setHoverTooltip(null);
        return;
      }
      setHoverTooltip({
        x: info.x,
        y: info.y,
        ...tooltip,
      });
    },
    [getFeatureTooltip]
  );

  const handleViewerRef = useCallback(
    (node: HTMLDivElement | null) => {
      viewerContainerRef.current = node;
      measureRef(node);
    },
    [measureRef]
  );

  const handleCenterOnSelectedLayer = useCallback(() => {
    if (!selectedLayerId || vw <= 0 || vh <= 0) return;
    const config = layers[selectedLayerId];
    if (!config) return;
    const b = getWorldBoundsForLayer(config.id);
    if (!b) return;
    actions.setViewState(viewStateFromBounds(b, vw, vh));
  }, [selectedLayerId, layers, vw, vh, getWorldBoundsForLayer, actions]);

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
  const viewerRect = viewerContainerRef.current?.getBoundingClientRect();
  /** Viewport coordinates of the deck.gl pick (for portaled `position: fixed` tooltip). */
  const tooltipClientPosition =
    hoverTooltip && viewerRect
      ? {
          x: viewerRect.left + hoverTooltip.x,
          y: viewerRect.top + hoverTooltip.y,
        }
      : null;

  const shellStyle: CSSProperties = fullscreen
    ? { ...containerStyle, ...fullscreenOverlayStyle, position: 'fixed' }
    : { ...containerStyle, position: 'relative' };

  const tooltipPayload: SpatialFeatureTooltipData | null =
    hoverTooltip && tooltipClientPosition
      ? {
          title: hoverTooltip.title,
          items: hoverTooltip.items,
        }
      : null;

  const portalTarget = typeof document !== 'undefined' ? (tooltipContainer ?? document.body) : null;

  const tooltipPortal =
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
            <button
              type="button"
              style={{ ...selectStyle, marginLeft: 'auto', cursor: 'pointer' }}
              onClick={() => setFullscreen((f) => !f)}
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
            {hasEnabledLayers ? (
              viewState === null ? (
                <div style={placeholderStyle}>
                  {isBlocking ? 'Loading layer data...' : 'Framing view...'}
                </div>
              ) : (
                <div style={{ width: vw, height: vh, position: 'relative' }}>
                  <SpatialViewer
                    width={vw}
                    height={vh}
                    viewState={viewState}
                    onViewStateChange={handleViewStateChange}
                    layers={deckLayers}
                    vivLayerProps={vivLayerProps.length > 0 ? vivLayerProps : undefined}
                    onHover={handleHover}
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
              )
            ) : (
              <div style={placeholderStyle}>
                {coordinateSystem ? 'Select layers to display' : 'Select a coordinate system'}
              </div>
            )}
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
                    cursor:
                      vw > 0 && vh > 0 && selectedLayerWorldBounds ? 'pointer' : 'not-allowed',
                    opacity: vw > 0 && vh > 0 && selectedLayerWorldBounds ? 1 : 0.5,
                  }}
                  disabled={vw <= 0 || vh <= 0 || !selectedLayerWorldBounds}
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
                          ? ' (blocking)'
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
                  <ImageChannelPanel
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
}: SpatialCanvasProps) {
  return (
    <VivLoaderRegistryProvider>
      <SpatialCanvasProvider store={store}>
        <SpatialCanvasInner tooltipContainer={tooltipContainer} renderTooltip={renderTooltip} />
      </SpatialCanvasProvider>
    </VivLoaderRegistryProvider>
  );
}
