import { Matrix4 } from '@math.gl/core';
import type { PointsElement, ShapesElement, SpatialData } from '@spatialdata/core';
import { renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { AvailableElement, ElementsByType, LayerConfig } from '../src/SpatialCanvas/types.js';
import { useLayerData } from '../src/SpatialCanvas/useLayerData.js';

/**
 * The first test that actually RENDERS `useLayerData`.
 *
 * Until this file, nothing did. Two specs import from the module — one takes a
 * type, one takes two module-scope helpers — but the 1,873-line hook itself was
 * never invoked by any test in the repo. Its entire public surface, seventeen
 * members that reach MDV through a `...layerData` spread, was unguarded.
 *
 * That is untenable for the Resource Resolver work, which dissolves six of the
 * hook's seven kind-switch ladders and re-points all seventeen members at a
 * resolver snapshot. This file is the net. It is written against the CURRENT
 * hook — it must be green before the refactor and stay green through it.
 *
 * It deliberately asserts the CONTRACT (the surface, the load lifecycle, resource
 * identity), not the implementation. Nothing here should need to change when the
 * internals are replaced; if something does, that is the signal to look hard at
 * whether the shim is honest.
 */

/** The seventeen members MDV consumes. This list IS the compat contract. */
const PUBLIC_SURFACE = [
  'getLayers',
  'getVivLayerProps',
  'getImageLayerLoadedData',
  'getImageLoadedDataByElementKey',
  'getLabelsLayerLoadedData',
  'getLayerLoadState',
  'hasRenderableLayerData',
  'pointsEngine',
  'resolvePointsTarget',
  'getFeatureTooltip',
  'getFeaturePickEvent',
  'getShapePickEvent',
  'isLoading',
  'isBlocking',
  'reloadElement',
  'getWorldBoundsForLayer',
  'getWorldBoundsForVisibleLayers',
] as const;

const EMPTY_ELEMENTS: ElementsByType = { images: [], shapes: [], points: [], labels: [] };

function pointsElement(key: string): AvailableElement {
  const element = {
    key,
    loadPoints: vi.fn(async () => ({
      shape: [2, 3],
      data: [new Float32Array([0, 1, 2]), new Float32Array([3, 4, 5])],
      featureCodes: new Int32Array([0, 1, 0]),
    })),
    listFeaturesWithCounts: vi.fn(async () => null),
  } as unknown as PointsElement;
  return { key, type: 'points', element, transform: new Matrix4() };
}

function shapesElement(key: string): AvailableElement {
  // Xenium-style cell circles: columnar centres + radii, which is what
  // `ShapeCircleColumnar` actually is — NOT an array of {x, y, radius} objects.
  const element = {
    key,
    loadRenderData: vi.fn(async () => ({
      kind: 'js-polygons' as const,
      geometryKind: 'circle' as const,
      elementKey: key,
      featureIds: ['c1', 'c2'],
      circles: {
        positions: [new Float32Array([0, 5]), new Float32Array([0, 5])] as [
          Float32Array,
          Float32Array,
        ],
        radii: new Float32Array([1, 1]),
      },
      rowIndexByFeatureIndex: new Int32Array([0, 1]),
    })),
  } as unknown as ShapesElement;
  return { key, type: 'shapes', element, transform: new Matrix4() };
}

const pointsConfig = (id: string, elementKey: string): LayerConfig => ({
  id,
  type: 'points',
  elementKey,
  visible: true,
  opacity: 1,
});

const shapesConfig = (id: string, elementKey: string): LayerConfig => ({
  id,
  type: 'shapes',
  elementKey,
  visible: true,
  opacity: 1,
});

const render = (layers: Record<string, LayerConfig>, elements: ElementsByType) =>
  renderHook(() => useLayerData(layers, Object.keys(layers), elements, null));

describe('useLayerData — the 17-member public surface', () => {
  // ADR 0004 promises MDV that this surface survives the refactor behind a compat
  // shim. MDV gets it via `...layerData` in SpatialCanvasViewer, so a member that
  // silently vanishes is a downstream break with no local failure.
  it('exposes exactly the seventeen members, and no more', () => {
    const { result } = render({}, EMPTY_ELEMENTS);

    expect(Object.keys(result.current).sort()).toEqual([...PUBLIC_SURFACE].sort());
  });

  it.each(PUBLIC_SURFACE)('exposes %s', (member) => {
    const { result } = render({}, EMPTY_ELEMENTS);

    expect(result.current[member]).toBeDefined();
  });

  it('is inert with no layers — no bounds, not loading, not blocking', () => {
    const { result } = render({}, EMPTY_ELEMENTS);

    expect(result.current.getLayers()).toEqual([]);
    expect(result.current.getVivLayerProps()).toEqual([]);
    expect(result.current.isLoading).toBe(false);
    expect(result.current.isBlocking).toBe(false);
    expect(result.current.getWorldBoundsForVisibleLayers()).toBeNull();
  });
});

describe('useLayerData — the load lifecycle', () => {
  it('drives a shapes layer idle -> ready and produces a deck layer', async () => {
    const elements: ElementsByType = { ...EMPTY_ELEMENTS, shapes: [shapesElement('cells')] };

    const { result } = render({ 'layer-1': shapesConfig('layer-1', 'cells') }, elements);

    // Nothing is renderable before the load resolves.
    expect(result.current.hasRenderableLayerData('layer-1')).toBe(false);

    await waitFor(() => {
      expect(result.current.getLayerLoadState('layer-1')?.geometry).toBe('ready');
    });

    expect(result.current.hasRenderableLayerData('layer-1')).toBe(true);
    expect(result.current.getLayers().length).toBeGreaterThan(0);
    expect(result.current.isBlocking).toBe(false);
  });

  it('produces a deck layer for a points layer', async () => {
    const elements: ElementsByType = { ...EMPTY_ELEMENTS, points: [pointsElement('transcripts')] };

    const { result } = render({ 'layer-p': pointsConfig('layer-p', 'transcripts') }, elements);

    await waitFor(() => {
      expect(result.current.hasRenderableLayerData('layer-p')).toBe(true);
    });

    expect(result.current.getLayers().length).toBeGreaterThan(0);
  });

  it('reports world bounds once a layer has data', async () => {
    const elements: ElementsByType = { ...EMPTY_ELEMENTS, shapes: [shapesElement('cells')] };

    const { result } = render({ 'layer-1': shapesConfig('layer-1', 'cells') }, elements);

    await waitFor(() => {
      expect(result.current.getWorldBoundsForLayer('layer-1')).not.toBeNull();
    });

    expect(result.current.getWorldBoundsForVisibleLayers()).not.toBeNull();
  });

  it('does not resolve a points target for a shapes layer', async () => {
    const elements: ElementsByType = {
      ...EMPTY_ELEMENTS,
      shapes: [shapesElement('cells')],
      points: [pointsElement('transcripts')],
    };

    const { result } = render(
      {
        'layer-s': shapesConfig('layer-s', 'cells'),
        'layer-p': pointsConfig('layer-p', 'transcripts'),
      },
      elements
    );

    expect(result.current.resolvePointsTarget('layer-s')).toBeUndefined();
    expect(result.current.resolvePointsTarget('layer-p')).toMatchObject({
      key: 'transcripts',
      layerId: 'layer-p',
    });
  });
});

describe('useLayerData — render-resource identity', () => {
  // THE regression this whole design guards against. Deck rebuilds a layer's batch
  // when its `data` identity changes, so a resource rebuilt per getLayers() call is
  // a teardown per frame: the pan flash. `getLayers()` is called on every render —
  // every pan, hover and viewState tick — so it must be idempotent within a commit.
  it('returns an identity-stable points resource across repeated getLayers() calls', async () => {
    const elements: ElementsByType = { ...EMPTY_ELEMENTS, points: [pointsElement('transcripts')] };

    const { result } = render({ 'layer-p': pointsConfig('layer-p', 'transcripts') }, elements);

    await waitFor(() => {
      expect(result.current.hasRenderableLayerData('layer-p')).toBe(true);
    });

    // Three "frames" in one commit. Deck must see one resource, not three.
    const resources = [0, 1, 2].map(
      () => (result.current.getLayers()[0]?.props as { resource?: unknown } | undefined)?.resource
    );

    expect(resources[0]).toBeDefined();
    expect(resources[1]).toBe(resources[0]);
    expect(resources[2]).toBe(resources[0]);
  });

  it('keeps the points resource stable across an unrelated re-render', async () => {
    const elements: ElementsByType = { ...EMPTY_ELEMENTS, points: [pointsElement('transcripts')] };
    const layers = { 'layer-p': pointsConfig('layer-p', 'transcripts') };

    const { result, rerender } = renderHook(
      ({ l }: { l: Record<string, LayerConfig> }) =>
        useLayerData(l, Object.keys(l), elements, null),
      { initialProps: { l: layers } }
    );

    await waitFor(() => {
      expect(result.current.hasRenderableLayerData('layer-p')).toBe(true);
    });
    const before = (result.current.getLayers()[0]?.props as { resource?: unknown }).resource;

    // Same config object, new render — nothing about the DATA changed.
    rerender({ l: layers });
    const after = (result.current.getLayers()[0]?.props as { resource?: unknown }).resource;

    expect(after).toBe(before);
  });
});

describe('useLayerData — resolver lifecycle across a dataset swap', () => {
  // The load-bearing guard for `createNonOwningResolver`. Shapes/images/labels
  // resolvers close over `spatialData`, so a dataset swap rebuilds them AND the
  // SpatialEntryStore that holds them; the old store is disposed. Points, by
  // contrast, is owned by the stable PointsDataEngine and only BORROWED by the store
  // through a non-owning proxy. If that proxy ever regressed to a real `dispose`, the
  // store teardown would clear the engine's cache — and this test would catch it:
  // the resident points batch (and its stable render-resource identity) must survive
  // the swap untouched.
  it('preserves the points cache when spatialData changes and the store is rebuilt', async () => {
    const elements: ElementsByType = { ...EMPTY_ELEMENTS, points: [pointsElement('transcripts')] };
    const layers = { 'layer-p': pointsConfig('layer-p', 'transcripts') };
    const datasetA = {} as SpatialData;
    const datasetB = {} as SpatialData;

    const { result, rerender } = renderHook(
      ({ sd }: { sd: SpatialData }) =>
        useLayerData(layers, Object.keys(layers), elements, null, sd),
      { initialProps: { sd: datasetA } }
    );

    const pointsResource = () => {
      const [layer] = result.current.getLayers();
      return (layer?.props as { resource?: unknown } | undefined)?.resource;
    };

    await waitFor(() => {
      expect(result.current.hasRenderableLayerData('layer-p')).toBe(true);
    });
    const before = pointsResource();
    expect(before).toBeDefined();

    // Swap the dataset. New spatialData identity → shapes/images/labels resolvers and
    // the store are rebuilt, and the previous store is disposed.
    rerender({ sd: datasetB });

    // The engine (held via the non-owning proxy) was NOT disposed: its resident batch
    // is still present and hands back the same identity-stable render resource.
    expect(result.current.hasRenderableLayerData('layer-p')).toBe(true);
    expect(pointsResource()).toBe(before);
  });
});

describe('useLayerData — coverage-gated base (never shows the wrong gene)', () => {
  // The reported bug: select gene A, deselect, select disjoint gene B → the base
  // drew ALL of A's points (the matched batch survives a selection change as
  // `stale`) until B's scan settled. The base must use the matched batch ONLY when
  // it covers the current selection; otherwise show the resident preload (filtered
  // to B) while B streams in.
  function scanPointsElement(key: string): AvailableElement {
    const resident = {
      shape: [2, 3],
      data: [new Float32Array([0, 1, 2]), new Float32Array([3, 4, 5])],
      featureCodes: new Int32Array([0, 1, 0]),
      hasFeatureCodeColumn: true, // → supportsFeatureScan true right after preload
    };
    const matchedForZero = {
      shape: [2, 2],
      data: [new Float32Array([0, 1]), new Float32Array([0, 1])],
      featureCodes: new Int32Array([0, 0]),
    };
    const element = {
      key,
      loadPoints: vi.fn(async () => resident),
      loadRowFeatureCodes: vi.fn(async () => new Int32Array([0, 1, 0])),
      listFeaturesWithCounts: vi.fn(async () => null),
      // The {0} scan settles; the {1} scan is left in flight so `lastGood` stays {0}
      // — the exact window where the old code drew the wrong gene.
      loadPointsMatchingFeatureCodes: vi.fn((opts: { featureCodes: readonly number[] }) =>
        opts.featureCodes[0] === 0 ? Promise.resolve(matchedForZero) : new Promise<never>(() => {})
      ),
    } as unknown as PointsElement;
    return { key, type: 'points', element, transform: new Matrix4() };
  }

  it('draws the resident batch (not the stale matched batch), via one stable base resource', async () => {
    const pts = scanPointsElement('transcripts');
    const elements: ElementsByType = { ...EMPTY_ELEMENTS, points: [pts] };

    const { result, rerender } = renderHook(
      ({ l }: { l: Record<string, LayerConfig> }) =>
        useLayerData(l, Object.keys(l), elements, null),
      {
        initialProps: {
          l: { 'layer-p': { ...pointsConfig('layer-p', 'transcripts'), featureCodes: [0] } },
        },
      }
    );
    type LoadAllResource = { loader: { loadAll?: () => Promise<{ shape: number[] }> } };
    const baseResource = () =>
      (result.current.getLayers()[0]?.props as { resource?: LoadAllResource } | undefined)
        ?.resource;
    const baseRowCount = async () => (await baseResource()?.loader.loadAll?.())?.shape[1];

    // The {0} scan settles → the matched batch covers {0}; the base draws it (2 rows).
    await waitFor(() => {
      expect(result.current.pointsEngine.getLoadedMatchingFeatureCodes('transcripts')?.has(0)).toBe(
        true
      );
    });
    const before = baseResource();
    expect(await baseRowCount()).toBe(2); // matched-{0}

    // Switch to a DISJOINT gene {1}; its scan is in flight, so `lastGood` is still {0}.
    rerender({
      l: { 'layer-p': { ...pointsConfig('layer-p', 'transcripts'), featureCodes: [1] } },
    });
    await waitFor(() => {
      expect(result.current.pointsEngine.isMatchingLoading('transcripts', [1])).toBe(true);
    });

    // P2: the base resource identity is STABLE across the resident↔matched swap — no
    // teardown, no flicker. P1: it now draws the RESIDENT batch (3 rows), never the
    // stale matched-{0} batch (2 rows).
    expect(baseResource()).toBe(before);
    expect(await baseRowCount()).toBe(3);
  });
});

describe('useLayerData — selection show/hide + colour', () => {
  // Two more reported bugs beyond the disjoint switch above:
  //   (A) GROWING a selection ([0] → [0,1]) blinked gene 0 out to the resident window
  //       until gene 1's scan settled — a wanted gene vanishing.
  //   (colour) the "all features" view (no selection, no explicit flag) drew flat
  //       because per-row codes were never threaded, though colour-by-feature is on by
  //       default in the renderer.
  function coverableElement(key: string): AvailableElement {
    const resident = {
      shape: [2, 3],
      data: [new Float32Array([0, 1, 2]), new Float32Array([3, 4, 5])],
      featureCodes: new Int32Array([0, 1, 0]),
      hasFeatureCodeColumn: true,
    };
    const matchedForZero = {
      shape: [2, 2],
      data: [new Float32Array([0, 1]), new Float32Array([0, 1])],
      featureCodes: new Int32Array([0, 0]),
    };
    const element = {
      key,
      loadPoints: vi.fn(async () => resident),
      loadRowFeatureCodes: vi.fn(async () => new Int32Array([0, 1, 0])),
      listFeaturesWithCounts: vi.fn(async () => null),
      // ONLY the exact {0} scan settles; any other selection (e.g. the grown {0,1})
      // stays in flight, so `lastGood` — and thus coverage — remains {0}.
      loadPointsMatchingFeatureCodes: vi.fn((opts: { featureCodes: readonly number[] }) =>
        opts.featureCodes.length === 1 && opts.featureCodes[0] === 0
          ? Promise.resolve(matchedForZero)
          : new Promise<never>(() => {})
      ),
    } as unknown as PointsElement;
    return { key, type: 'points', element, transform: new Matrix4() };
  }

  it('keeps the matched batch as the base when growing a covered selection (a wanted gene never blinks out)', async () => {
    const pts = coverableElement('transcripts');
    const elements: ElementsByType = { ...EMPTY_ELEMENTS, points: [pts] };

    const { result, rerender } = renderHook(
      ({ l }: { l: Record<string, LayerConfig> }) =>
        useLayerData(l, Object.keys(l), elements, null),
      {
        initialProps: {
          l: { 'layer-p': { ...pointsConfig('layer-p', 'transcripts'), featureCodes: [0] } },
        },
      }
    );
    type LoadAllResource = { loader: { loadAll?: () => Promise<{ shape: number[] }> } };
    const baseResource = () =>
      (result.current.getLayers()[0]?.props as { resource?: LoadAllResource } | undefined)
        ?.resource;
    const baseRowCount = async () => (await baseResource()?.loader.loadAll?.())?.shape[1];

    await waitFor(() => {
      expect(result.current.pointsEngine.getLoadedMatchingFeatureCodes('transcripts')?.has(0)).toBe(
        true
      );
    });
    expect(await baseRowCount()).toBe(2); // matched-{0}

    // GROW {0} → {0,1}. Gene 1's scan hangs, so coverage stays {0}. The base must keep
    // drawing the whole-dataset matched-{0} batch (2 rows) — gene 0 does NOT blink out
    // to the resident window (3 rows) while gene 1 streams in via the overlay.
    rerender({
      l: { 'layer-p': { ...pointsConfig('layer-p', 'transcripts'), featureCodes: [0, 1] } },
    });
    await waitFor(() => {
      expect(result.current.pointsEngine.isMatchingLoading('transcripts', [0, 1])).toBe(true);
    });
    expect(await baseRowCount()).toBe(2); // still matched-{0}, never resident-3
  });

  it('threads per-row codes to the base for the "all features" view (colour is on by default)', async () => {
    const pts = coverableElement('transcripts');
    const elements: ElementsByType = { ...EMPTY_ELEMENTS, points: [pts] };

    // No `featureCodes` (⇒ "all features") and no `colorByFeature` flag: the base must
    // still carry the per-row codes so the shader can colour by feature.
    const { result } = render({ 'layer-p': pointsConfig('layer-p', 'transcripts') }, elements);

    await waitFor(() => {
      expect(result.current.pointsEngine.getRowFeatureCodes('transcripts')).toBeDefined();
    });
    const basePreloadedCodes = () =>
      (
        result.current.getLayers()[0]?.props as
          | { preloadedFeatureCodes?: ArrayLike<number> }
          | undefined
      )?.preloadedFeatureCodes;
    await waitFor(() => {
      expect(basePreloadedCodes()).toBeDefined();
    });
    expect(basePreloadedCodes()?.length).toBe(3);
  });
});
