/**
 * With keepLayersOnSourceChange, switching SpatialCanvas to another dataset keeps
 * its layers; those whose element the dataset lacks are marked and wait for one that has it.
 */

import { Matrix4 } from '@math.gl/core';
import type { SpatialData } from '@spatialdata/core';
import { act, render, screen } from '@testing-library/react';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import SpatialCanvas from '../src/SpatialCanvas/index.js';
import { createSpatialCanvasStore } from '../src/SpatialCanvas/stores.js';
import type { LayerConfig } from '../src/SpatialCanvas/types.js';

// The dataset `useSpatialData` reports, as an external store so a switch re-renders.
const current = vi.hoisted(() => {
  const listeners = new Set<() => void>();
  return {
    value: { spatialData: null as unknown, loading: false, error: null },
    listeners,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
});

vi.mock('@spatialdata/react', async () => {
  const { useSyncExternalStore } = await import('react');
  return {
    useSpatialData: () => useSyncExternalStore(current.subscribe, () => current.value),
  };
});
// jsdom has no GPU; the viewer is not what this test is about.
vi.mock('../src/SpatialCanvas/SpatialViewer.js', () => ({ SpatialViewer: () => null }));

beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});

function element(key: string) {
  return {
    key,
    attrs: {},
    getIssues: () => [],
    getTransformation: () => ({ ok: true, value: { toMatrix: () => new Matrix4() } }),
  };
}

function dataset(
  coordinateSystems: string[],
  elements: { images?: string[]; shapes?: string[]; points?: string[] }
): SpatialData {
  const collection = (keys: string[] = []) =>
    Object.fromEntries(keys.map((key) => [key, element(key)]));
  // A stub: SpatialCanvas reads only these members for hidden layers.
  return {
    coordinateSystems,
    images: collection(elements.images),
    shapes: collection(elements.shapes),
    points: collection(elements.points),
    getAssociatedTable: () => undefined,
  } as unknown as SpatialData;
}

const morphology: LayerConfig = {
  id: 'image:morphology',
  type: 'image',
  elementKey: 'morphology',
  visible: false,
  opacity: 0.4,
};
const cells: LayerConfig = {
  id: 'shapes:cells',
  type: 'shapes',
  elementKey: 'cells',
  visible: false,
  opacity: 0.7,
  fillColor: [255, 0, 0, 255],
};
const transcripts: LayerConfig = {
  id: 'points:transcripts',
  type: 'points',
  elementKey: 'transcripts',
  visible: false,
  opacity: 1,
  featureNames: ['EPCAM'],
};

function switchTo(spatialData: SpatialData | null) {
  act(() => {
    current.value = { spatialData, loading: spatialData === null, error: null };
    for (const listener of current.listeners) listener();
  });
}

function setup(first: SpatialData, keepLayersOnSourceChange = true) {
  const store = createSpatialCanvasStore();
  current.value = { spatialData: first, loading: false, error: null };
  render(<SpatialCanvas store={store} keepLayersOnSourceChange={keepLayersOnSourceChange} />);
  act(() => {
    const actions = store.getState();
    actions.setCoordinateSystem('global');
    for (const config of [morphology, cells, transcripts]) actions.addLayer(config);
    actions.setSelectedLayerId(cells.id);
  });
  return store;
}

const runA = dataset(['global'], {
  images: ['morphology'],
  shapes: ['cells'],
  points: ['transcripts'],
});

describe('SpatialCanvas keepLayersOnSourceChange', () => {
  beforeEach(() => {
    current.value = { spatialData: null, loading: false, error: null };
  });

  it('keeps every layer, as configured, when the next dataset has the same elements', () => {
    const store = setup(runA);
    act(() => store.getState().setViewState({ target: [5, 5], zoom: 3 }));
    const before = store.getState();

    switchTo(null); // the next store loading
    switchTo(
      dataset(['global'], { images: ['morphology'], shapes: ['cells'], points: ['transcripts'] })
    );

    const after = store.getState();
    expect(after.layerOrder).toEqual(before.layerOrder);
    expect(after.layers).toEqual(before.layers);
    expect(after.coordinateSystem).toBe('global');
    expect(after.selectedLayerId).toBe(cells.id);
    // Cleared so the view refits to the new dataset.
    expect(after.viewState).toBeNull();
    expect(screen.queryAllByText('unavailable')).toHaveLength(0);
  });

  it('keeps layers whose element is missing dormant, and wakes them when a dataset has it', () => {
    const store = setup(runA);
    const before = store.getState();

    switchTo(dataset(['global'], { images: ['morphology'], shapes: ['nuclei'] }));

    expect(store.getState().layers).toEqual(before.layers);
    expect(screen.getAllByText('unavailable')).toHaveLength(2);
    expect(screen.getByDisplayValue('cells (shapes)').parentElement?.title).toContain('cells');

    switchTo(
      dataset(['global'], { images: ['morphology'], shapes: ['cells'], points: ['transcripts'] })
    );

    expect(store.getState().layerOrder).toEqual(before.layerOrder);
    expect(store.getState().layers).toEqual(before.layers);
    expect(screen.queryAllByText('unavailable')).toHaveLength(0);
  });

  it('clears a coordinate system the next dataset lacks, keeping the layers', () => {
    const store = setup(runA);
    switchTo(dataset(['aligned', 'micron'], { images: ['morphology'] }));
    expect(store.getState().coordinateSystem).toBeNull();
    expect(store.getState().layerOrder).toEqual([morphology.id, cells.id, transcripts.id]);
  });

  it('keeps the layers through a coordinate-system change', () => {
    const store = setup(dataset(['global', 'micron'], { images: ['morphology'] }));
    act(() => store.getState().setCoordinateSystem('micron'));
    expect(store.getState().layerOrder).toEqual([morphology.id, cells.id, transcripts.id]);
  });

  it('still clears the layers on a dataset change without the prop', () => {
    const store = setup(runA, false);
    switchTo(
      dataset(['global'], { images: ['morphology'], shapes: ['cells'], points: ['transcripts'] })
    );
    expect(store.getState().layerOrder).toEqual([]);
    expect(store.getState().coordinateSystem).toBe('global');
  });
});
