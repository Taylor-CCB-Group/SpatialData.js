/**
 * SpatialCanvas - A UI-driven component for composing spatial layers
 * 
 * Provides a complete interface for:
 * - Selecting a coordinate system
 * - Choosing which elements to display
 * - Viewing overlaid spatial data with pan/zoom
 */

import { useEffect, useMemo, useCallback, type CSSProperties } from 'react';
import { useMeasure } from '@uidotdev/usehooks';
import { useSpatialData } from '@spatialdata/react';
import { 
  SpatialCanvasProvider, 
  useSpatialCanvasStore, 
  useSpatialCanvasActions,
  useSpatialCanvasStoreApi,
} from './context';
import { 
  getAvailableElements, 
  getAllCoordinateSystems,
  generateLayerId,
} from './utils';
import type { 
  AvailableElement, 
  ElementsByType, 
  LayerConfig,
  ViewState,
} from './types';
import type { SpatialCanvasStoreApi } from './stores';
import { useLayerData } from './useLayerData';
import { SpatialViewer } from './SpatialViewer';

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
  const typeLabels: Record<typeof elementTypes[number], string> = {
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

function SpatialCanvasInner() {
  const { spatialData, loading: sdLoading } = useSpatialData();
  const [ref, { width, height }] = useMeasure();
  
  // Store state
  const coordinateSystem = useSpatialCanvasStore(s => s.coordinateSystem);
  const layers = useSpatialCanvasStore(s => s.layers);
  const layerOrder = useSpatialCanvasStore(s => s.layerOrder);
  const viewState = useSpatialCanvasStore(s => s.viewState);
  
  // Actions
  const actions = useSpatialCanvasActions();

  // Derived state
  const coordinateSystems = useMemo(() => {
    if (!spatialData) return [];
    return getAllCoordinateSystems(spatialData);
  }, [spatialData]);

  const availableElements = useMemo(() => {
    if (!spatialData || !coordinateSystem) {
      return { images: [], shapes: [], points: [], labels: [] };
    }
    return getAvailableElements(spatialData, coordinateSystem);
  }, [spatialData, coordinateSystem]);

  const enabledLayerIds = useMemo(() => {
    return new Set(layerOrder.filter(id => layers[id]?.visible));
  }, [layers, layerOrder]);

  // Auto-select first coordinate system
  useEffect(() => {
    if (coordinateSystems.length > 0 && !coordinateSystem) {
      actions.setCoordinateSystem(coordinateSystems[0]);
    }
  }, [coordinateSystems, coordinateSystem, actions]);

  // Clear layers when coordinate system changes
  useEffect(() => {
    actions.reset();
    if (coordinateSystem && coordinateSystems.includes(coordinateSystem)) {
      actions.setCoordinateSystem(coordinateSystem);
    }
  }, [coordinateSystem, coordinateSystems, actions]);

  // Handlers
  const handleCSChange = useCallback((e: React.ChangeEvent<HTMLSelectElement>) => {
    actions.setCoordinateSystem(e.target.value || null);
  }, [actions]);

  const handleToggleLayer = useCallback((element: AvailableElement) => {
    const layerId = generateLayerId(element.type, element.key);
    const existing = layers[layerId];
    
    if (existing) {
      // Toggle visibility
      actions.toggleLayerVisibility(layerId);
    } else {
      // Add new layer
      const config: LayerConfig = {
        id: layerId,
        type: element.type,
        elementKey: element.key,
        visible: true,
        opacity: 1,
      };
      actions.addLayer(config);
    }
  }, [layers, actions]);

  // Loading state
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

  const hasElements = Object.values(availableElements).some(arr => arr.length > 0);
  const hasEnabledLayers = enabledLayerIds.size > 0;

  return (
    <div style={containerStyle}>
      {/* Controls */}
      <div style={controlsStyle}>
        <div style={rowStyle}>
          <span style={labelStyle}>Coordinate System:</span>
          <select 
            style={selectStyle}
            value={coordinateSystem || ''}
            onChange={handleCSChange}
          >
            <option value="">Select...</option>
            {coordinateSystems.map(cs => (
              <option key={cs} value={cs}>{cs}</option>
            ))}
          </select>
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

      {/* Viewer */}
      <div ref={ref} style={viewerContainerStyle}>
        {hasEnabledLayers ? (
          <SpatialCanvasViewer
            width={width || 0}
            height={height || 0}
            layers={layers}
            layerOrder={layerOrder}
            availableElements={availableElements}
            coordinateSystem={coordinateSystem}
            viewState={viewState}
            onViewStateChange={actions.setViewState}
          />
        ) : (
          <div style={placeholderStyle}>
            {coordinateSystem 
              ? 'Select layers to display' 
              : 'Select a coordinate system'}
          </div>
        )}
      </div>
    </div>
  );
}

// ============================================
// Viewer Component (renders deck.gl layers)
// ============================================

interface SpatialCanvasViewerProps {
  width: number;
  height: number;
  layers: Record<string, LayerConfig>;
  layerOrder: string[];
  availableElements: ElementsByType;
  coordinateSystem: string | null;
  viewState: ViewState | null;
  onViewStateChange: (vs: ViewState | null) => void;
}

function SpatialCanvasViewer({ 
  width, 
  height, 
  layers, 
  layerOrder,
  availableElements,
  coordinateSystem,
  viewState,
  onViewStateChange,
}: SpatialCanvasViewerProps) {
  // Load layer data and get deck.gl layers
  const { getLayers, isLoading } = useLayerData(
    layers, 
    layerOrder, 
    availableElements,
    coordinateSystem,
  );

  const deckLayers = getLayers();

  // Handle view state change, converting null to default
  const handleViewStateChange = useCallback((vs: ViewState) => {
    onViewStateChange(vs);
  }, [onViewStateChange]);

  return (
    <div style={{ width, height, position: 'relative' }}>
      <SpatialViewer
        width={width}
        height={height}
        viewState={viewState}
        onViewStateChange={handleViewStateChange}
        layers={deckLayers}
      />
      {isLoading && (
        <div style={{
          position: 'absolute',
          top: 8,
          right: 8,
          padding: '4px 8px',
          backgroundColor: 'rgba(0,0,0,0.7)',
          color: '#fff',
          fontSize: '11px',
          borderRadius: 4,
        }}>
          Loading...
        </div>
      )}
      {deckLayers.length === 0 && !isLoading && (
        <div style={{
          position: 'absolute',
          top: '50%',
          left: '50%',
          transform: 'translate(-50%, -50%)',
          color: '#666',
          fontSize: '13px',
        }}>
          No layers to display
        </div>
      )}
    </div>
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
}

/**
 * SpatialCanvas provides a complete UI for viewing and composing spatial data layers.
 * 
 * It uses SpatialData from the nearest SpatialDataProvider context and allows users to:
 * - Select a coordinate system
 * - Toggle visibility of elements that can be displayed in that coordinate system
 * - Pan and zoom the view
 * 
 * @example Basic usage
 * ```tsx
 * <SpatialDataProvider url="https://example.com/data.zarr">
 *   <SpatialCanvas />
 * </SpatialDataProvider>
 * ```
 * 
 * @example With external store (for MDV integration)
 * ```tsx
 * const store = createSpatialCanvasStore();
 * 
 * <SpatialDataProvider url="...">
 *   <SpatialCanvas store={store} />
 * </SpatialDataProvider>
 * 
 * // Store can also be accessed externally
 * store.getState().setCoordinateSystem('global');
 * ```
 */
export default function SpatialCanvas({ store }: SpatialCanvasProps) {
  return (
    <SpatialCanvasProvider store={store}>
      <SpatialCanvasInner />
    </SpatialCanvasProvider>
  );
}

