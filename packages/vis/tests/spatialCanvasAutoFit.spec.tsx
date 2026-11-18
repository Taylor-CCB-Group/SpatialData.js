/**
 * SpatialCanvas frames the view once its layers have bounds. Shapes load without
 * blocking, so "no bounds" before their geometry arrives must not settle the view.
 */

import type { SpatialData } from '@spatialdata/core';
import { act, render } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import SpatialCanvas from '../src/SpatialCanvas/index.js';
import { createSpatialCanvasStore } from '../src/SpatialCanvas/stores.js';

// The renderer state SpatialCanvas reads, as an external store the test drives.
const renderer = vi.hoisted(() => {
  const listeners = new Set<() => void>();
  return {
    state: {
      isLoading: false,
      bounds: null as null | { minX: number; minY: number; maxX: number; maxY: number },
    },
    listeners,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
});

function setRenderer(next: Partial<typeof renderer.state>) {
  act(() => {
    renderer.state = { ...renderer.state, ...next };
    for (const listener of renderer.listeners) listener();
  });
}

const spatialData = {
  coordinateSystems: ['global'],
  shapes: { cells: {} },
  getAssociatedTable: () => undefined,
} as unknown as SpatialData;

vi.mock('@spatialdata/react', () => ({
  useSpatialData: () => ({ spatialData, loading: false, error: null }),
}));
vi.mock('@uidotdev/usehooks', () => ({
  useMeasure: () => [() => {}, { width: 200, height: 100 }],
}));
// jsdom has no GPU; the viewer is not what this test is about.
vi.mock('../src/SpatialCanvas/SpatialViewer.js', () => ({ SpatialViewer: () => null }));
vi.mock('../src/SpatialCanvas/SpatialCanvasViewer.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../src/SpatialCanvas/SpatialCanvasViewer.js')>();
  const { useCallback, useSyncExternalStore } = await import('react');
  return {
    ...actual,
    useSpatialCanvasRendererFromLayerInputs: ({
      layerInputs,
    }: {
      layerInputs: { layers: Record<string, { visible: boolean }>; layerOrder: string[] };
    }) => {
      const state = useSyncExternalStore(renderer.subscribe, () => renderer.state);
      const getWorldBoundsForVisibleLayers = useCallback(() => state.bounds, [state.bounds]);
      const enabledLayerIds = new Set(
        layerInputs.layerOrder.filter((id) => layerInputs.layers[id]?.visible)
      );
      return {
        availableElements: actual.getEmptyElementsByType(),
        deckLayers: [],
        enabledLayerIds,
        getFeatureTooltip: () => null,
        getImageLayerLoadedData: () => undefined,
        getLabelsLayerLoadedData: () => undefined,
        getEntryStatus: () => undefined,
        getLayerLoadState: () => undefined,
        getWorldBoundsForLayer: () => null,
        getWorldBoundsForVisibleLayers,
        hasEnabledLayers: enabledLayerIds.size > 0,
        setHoveredLabel: () => {},
        hasLayersDrawn: false,
        hasRenderableLayerData: () => false,
        // Shapes never block.
        isBlocking: false,
        isLoading: state.isLoading,
        pointsEngine: undefined,
        resolvePointsTarget: () => undefined,
        retryEntry: async () => {},
        vivLayerProps: [],
      };
    },
  };
});

describe('SpatialCanvas auto-fit with a shapes-only view', () => {
  beforeEach(() => {
    renderer.state = { isLoading: false, bounds: null };
  });

  function setup() {
    const store = createSpatialCanvasStore();
    render(<SpatialCanvas store={store} keepLayersOnSourceChange />);
    act(() => {
      store.getState().setCoordinateSystem('global');
      store.getState().addLayer({
        id: 'shapes:cells',
        type: 'shapes',
        elementKey: 'cells',
        visible: true,
        opacity: 1,
      });
    });
    return store;
  }

  it('waits for the geometry to load, then frames it', () => {
    const store = setup();
    // Not loading yet and no bounds: the load has not started, so keep waiting.
    expect(store.getState().viewState).toBeNull();

    setRenderer({ isLoading: true });
    expect(store.getState().viewState).toBeNull();

    setRenderer({ isLoading: false, bounds: { minX: 100, minY: 100, maxX: 300, maxY: 200 } });
    expect(store.getState().viewState?.target).toEqual([200, 150]);
  });

  it('falls back to the origin when loading finishes without bounds', () => {
    const store = setup();
    setRenderer({ isLoading: true });
    setRenderer({ isLoading: false });
    expect(store.getState().viewState).toEqual({ target: [0, 0], zoom: 0 });
  });
});
