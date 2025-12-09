/**
 * React bindings for SpatialCanvas stores
 */

import { createContext, useContext, useMemo, type PropsWithChildren } from 'react';
import { useStore } from 'zustand';
import { createSpatialCanvasStore, type SpatialCanvasStoreApi } from './stores';
import type { SpatialCanvasStore } from './types';

// ============================================
// Context
// ============================================

const SpatialCanvasContext = createContext<SpatialCanvasStoreApi | null>(null);

// ============================================
// Provider
// ============================================

export interface SpatialCanvasProviderProps {
  /**
   * Optional external store. If provided, this store will be used instead of
   * creating a new one. Useful for:
   * - MDV integration where stores are owned by chart classes
   * - Sharing state between multiple components
   * - Testing with pre-configured state
   */
  store?: SpatialCanvasStoreApi;
}

/**
 * Provider for SpatialCanvas state.
 * 
 * Can either create its own store (default) or use an externally provided store.
 * This allows flexibility for different integration patterns:
 * 
 * @example Standalone (internal store)
 * ```tsx
 * <SpatialCanvasProvider>
 *   <SpatialCanvas />
 *   <LayerControls />
 * </SpatialCanvasProvider>
 * ```
 * 
 * @example External store (MDV integration)
 * ```tsx
 * // In class component
 * this.spatialStore = createSpatialCanvasStore();
 * 
 * // In render
 * <SpatialCanvasProvider store={this.spatialStore}>
 *   <SpatialCanvas />
 * </SpatialCanvasProvider>
 * ```
 */
export function SpatialCanvasProvider({ 
  store: externalStore, 
  children 
}: PropsWithChildren<SpatialCanvasProviderProps>) {
  const store = useMemo(
    () => externalStore ?? createSpatialCanvasStore(),
    [externalStore]
  );

  return (
    <SpatialCanvasContext.Provider value={store}>
      {children}
    </SpatialCanvasContext.Provider>
  );
}

// ============================================
// Hooks
// ============================================

/**
 * Get the raw store API for imperative access.
 * Useful when you need to call actions outside of React's render cycle.
 */
export function useSpatialCanvasStoreApi(): SpatialCanvasStoreApi {
  const store = useContext(SpatialCanvasContext);
  if (!store) {
    throw new Error('useSpatialCanvasStoreApi must be used within a SpatialCanvasProvider');
  }
  return store;
}

/**
 * Subscribe to store state with a selector.
 * Re-renders only when the selected value changes.
 * 
 * @example
 * ```tsx
 * const coordinateSystem = useSpatialCanvasStore(s => s.coordinateSystem);
 * const { layers, layerOrder } = useSpatialCanvasStore(s => ({ 
 *   layers: s.layers, 
 *   layerOrder: s.layerOrder 
 * }));
 * ```
 */
export function useSpatialCanvasStore<U>(
  selector: (state: SpatialCanvasStore) => U,
): U {
  const store = useSpatialCanvasStoreApi();
  return useStore(store, selector);
}

/**
 * Get store actions without subscribing to state changes.
 * Useful for event handlers where you don't need reactive updates.
 */
export function useSpatialCanvasActions() {
  const store = useSpatialCanvasStoreApi();
  return useMemo(() => ({
    setCoordinateSystem: store.getState().setCoordinateSystem,
    setViewState: store.getState().setViewState,
    addLayer: store.getState().addLayer,
    removeLayer: store.getState().removeLayer,
    updateLayer: store.getState().updateLayer,
    toggleLayerVisibility: store.getState().toggleLayerVisibility,
    reorderLayers: store.getState().reorderLayers,
    setLoading: store.getState().setLoading,
    reset: store.getState().reset,
  }), [store]);
}

