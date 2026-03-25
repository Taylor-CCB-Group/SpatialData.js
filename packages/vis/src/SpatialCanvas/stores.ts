/**
 * Framework-agnostic zustand stores for SpatialCanvas
 * 
 * Uses zustand/vanilla so stores can be used without React.
 * React bindings are in ./context.tsx
 */

import { createStore } from 'zustand/vanilla';
import type { 
  SpatialCanvasState, 
  SpatialCanvasActions, 
  SpatialCanvasStore,
  LayerConfig,
  ViewState,
} from './types';

const initialState: SpatialCanvasState = {
  coordinateSystem: null,
  viewState: null,
  layers: {},
  layerOrder: [],
  selectedLayerId: null,
  isLoading: false,
};

export function createSpatialCanvasStore() {
  return createStore<SpatialCanvasStore>((set, get) => ({
    ...initialState,

    setCoordinateSystem: (cs) => {
      set({ coordinateSystem: cs });
    },

    setViewState: (vs) => {
      set({ viewState: vs });
    },

    addLayer: (config) => {
      set((state) => ({
        layers: { ...state.layers, [config.id]: config },
        layerOrder: [...state.layerOrder, config.id],
        selectedLayerId: config.id,
      }));
    },

    removeLayer: (id) => {
      set((state) => {
        const { [id]: _removed, ...remainingLayers } = state.layers;
        const nextOrder = state.layerOrder.filter((layerId) => layerId !== id);
        return {
          layers: remainingLayers,
          layerOrder: nextOrder,
          selectedLayerId: state.selectedLayerId === id ? nextOrder[nextOrder.length - 1] ?? null : state.selectedLayerId,
        };
      });
    },

    updateLayer: (id, updates) => {
      set((state) => {
        const existing = state.layers[id];
        if (!existing) return state;
        return {
          layers: {
            ...state.layers,
            [id]: { ...existing, ...updates } as LayerConfig,
          },
        };
      });
    },

    toggleLayerVisibility: (id) => {
      const existing = get().layers[id];
      if (!existing) return;
      set((state) => ({
        layers: {
          ...state.layers,
          [id]: { ...existing, visible: !existing.visible },
        },
      }));
    },

    reorderLayers: (newOrder) => {
      set({ layerOrder: newOrder });
    },

    setSelectedLayerId: (id) => {
      set({ selectedLayerId: id });
    },

    setLoading: (loading) => {
      set({ isLoading: loading });
    },

    reset: () => {
      set(initialState);
    },
  }));
}

export type SpatialCanvasStoreApi = ReturnType<typeof createSpatialCanvasStore>;

