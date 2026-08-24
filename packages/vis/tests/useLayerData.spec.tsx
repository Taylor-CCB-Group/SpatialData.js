import { Matrix4 } from '@math.gl/core';
import type { PointsElement, ShapesElement, SpatialData } from '@spatialdata/core';
import {
  createTiledPointsDebugHooks,
  type PointsTileHandle,
  type TileDebugStore,
} from '@spatialdata/layers';
import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { AvailableElement, ElementsByType, LayerConfig } from '../src/SpatialCanvas/types.js';
import { useLayerData } from '../src/SpatialCanvas/useLayerData.js';

/**
 * The first test that actually RENDERS `useLayerData`.
 *
 * Until this file, nothing did. Two specs import from the module — one takes a
 * type, one takes two module-scope helpers — but the 1,873-line hook itself was
 * never invoked by any test in the repo. Its entire public surface, eighteen
 * members that reach MDV through a `...layerData` spread, was unguarded.
 *
 * That is untenable for the Resource Resolver work, which dissolves six of the
 * hook's seven kind-switch ladders and re-points all eighteen members at a
 * resolver snapshot. This file is the net. It is written against the CURRENT
 * hook — it must be green before the refactor and stay green through it.
 *
 * It deliberately asserts the CONTRACT (the surface, the load lifecycle, resource
 * identity), not the implementation. Nothing here should need to change when the
 * internals are replaced; if something does, that is the signal to look hard at
 * whether the shim is honest.
 */

/** The eighteen members MDV consumes. This list IS the compat contract. */
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
  'setHoveredLabel',
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

describe('useLayerData — the 18-member public surface', () => {
  // ADR 0004 promises MDV that this surface survives the refactor behind a compat
  // shim. MDV gets it via `...layerData` in SpatialCanvasViewer, so a member that
  // silently vanishes is a downstream break with no local failure.
  it('exposes exactly the eighteen members, and no more', () => {
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
      // Truncated on purpose: a matching scan is only planned when rows exist
      // beyond the resident window. With a complete batch the resolver filters in
      // memory and never scans, so there would be no matched batch to gate on.
      preloadTruncated: true,
      totalRowCount: 100,
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
      // See the note in scanPointsElement: a scan is only planned for a truncated
      // resident batch, which is the situation these matched-vs-resident cases model.
      preloadTruncated: true,
      totalRowCount: 100,
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

  it('will not use the matched batch it cannot filter (a deselected gene must not survive)', async () => {
    // The matched batch covers TWO genes but carries no row-aligned codes. Narrowing
    // the selection to one of them therefore asks for a filter `PointsLayer` cannot
    // apply — and its strategy resolves "awaiting row codes" by drawing the batch
    // WHOLE. Passing the filter anyway is not a harmless no-op: it puts the just-
    // deselected gene back on screen. The base must fall back to the resident batch,
    // which filters in memory from codes it does have.
    const resident = {
      shape: [2, 3],
      data: [new Float32Array([0, 1, 2]), new Float32Array([3, 4, 5])],
      featureCodes: new Int32Array([0, 1, 0]),
      hasFeatureCodeColumn: true,
      preloadTruncated: true,
      totalRowCount: 100,
    };
    const matchedForBoth = {
      shape: [2, 4],
      data: [new Float32Array([0, 1, 2, 3]), new Float32Array([0, 1, 2, 3])],
      // Deliberately absent — `pointsScanChunkProgress` only sets `featureCodes`
      // when the scan produced them, so this is a shape the resolver can hand back.
    };
    const pts: AvailableElement = {
      key: 'transcripts',
      type: 'points',
      element: {
        key: 'transcripts',
        loadPoints: vi.fn(async () => resident),
        loadRowFeatureCodes: vi.fn(async () => new Int32Array([0, 1, 0])),
        listFeaturesWithCounts: vi.fn(async () => null),
        // Only the {0,1} scan settles, so `lastGood` coverage stays {0,1} after the
        // selection narrows to {0}.
        loadPointsMatchingFeatureCodes: vi.fn((opts: { featureCodes: readonly number[] }) =>
          opts.featureCodes.length === 2
            ? Promise.resolve(matchedForBoth)
            : new Promise<never>(() => {})
        ),
      } as unknown as PointsElement,
      transform: new Matrix4(),
    };
    const elements: ElementsByType = { ...EMPTY_ELEMENTS, points: [pts] };

    const { result, rerender } = renderHook(
      ({ l }: { l: Record<string, LayerConfig> }) =>
        useLayerData(l, Object.keys(l), elements, null),
      {
        initialProps: {
          l: { 'layer-p': { ...pointsConfig('layer-p', 'transcripts'), featureCodes: [0, 1] } },
        },
      }
    );
    type LoadAllResource = { loader: { loadAll?: () => Promise<{ shape: number[] }> } };
    const baseProps = () =>
      result.current.getLayers()[0]?.props as
        | { resource?: LoadAllResource; featureCodes?: readonly number[] }
        | undefined;
    const baseRowCount = async () => (await baseProps()?.resource?.loader.loadAll?.())?.shape[1];

    await waitFor(() => {
      expect(result.current.pointsEngine.getLoadedMatchingFeatureCodes('transcripts')?.size).toBe(
        2
      );
    });
    // Selection == coverage, so no filter is needed and the matched batch is usable.
    expect(await baseRowCount()).toBe(4);

    // NARROW {0,1} → {0}. Drawing matched-{0,1} would now require holding gene 1 back.
    rerender({
      l: { 'layer-p': { ...pointsConfig('layer-p', 'transcripts'), featureCodes: [0] } },
    });
    // Narrowing to a COVERED subset does not start a new scan — the resolver serves
    // it from `lastGood` — so wait on the rendered selection, not on a scan.
    await waitFor(() => {
      expect(baseProps()?.featureCodes).toEqual([0]);
    });
    expect(await baseRowCount()).toBe(3); // resident, NOT the 4-row unfilterable matched batch
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

describe('useLayerData — the hover highlight channel', () => {
  // Hover is runtime render state, and deck fires it on every pointer move. The
  // channel is a ref plus a version counter precisely so that motion WITHIN one
  // label is free; only crossing into a different label may re-render.
  const renderCounting = () => {
    let renders = 0;
    const hook = renderHook(() => {
      renders += 1;
      return useLayerData({}, [], EMPTY_ELEMENTS, null);
    });
    return { hook, getRenders: () => renders };
  };

  it('does not re-render when the hovered label is unchanged', async () => {
    const { hook, getRenders } = renderCounting();

    await act(async () => {
      hook.result.current.setHoveredLabel({ layerId: 'labels-1', labelId: 4 });
    });
    const afterFirst = getRenders();

    // The same label again — the pointer moved, the highlight did not.
    await act(async () => {
      hook.result.current.setHoveredLabel({ layerId: 'labels-1', labelId: 4 });
    });

    expect(getRenders()).toBe(afterFirst);
  });

  it('re-renders when the hovered label changes, and when it clears', async () => {
    const { hook, getRenders } = renderCounting();

    await act(async () => {
      hook.result.current.setHoveredLabel({ layerId: 'labels-1', labelId: 4 });
    });
    const afterFirst = getRenders();

    await act(async () => {
      hook.result.current.setHoveredLabel({ layerId: 'labels-1', labelId: 5 });
    });
    expect(getRenders()).toBeGreaterThan(afterFirst);
    const afterSecond = getRenders();

    await act(async () => {
      hook.result.current.setHoveredLabel(null);
    });
    expect(getRenders()).toBeGreaterThan(afterSecond);
  });

  it('treats the same label id on a different layer as a change', async () => {
    const { hook, getRenders } = renderCounting();

    await act(async () => {
      hook.result.current.setHoveredLabel({ layerId: 'labels-1', labelId: 4 });
    });
    const afterFirst = getRenders();

    // Two labels elements can share an id space; only the hovered LAYER highlights.
    await act(async () => {
      hook.result.current.setHoveredLabel({ layerId: 'labels-2', labelId: 4 });
    });

    expect(getRenders()).toBeGreaterThan(afterFirst);
  });

  it('clearing when nothing is hovered is free', async () => {
    const { hook, getRenders } = renderCounting();
    const baseline = getRenders();

    await act(async () => {
      hook.result.current.setHoveredLabel(null);
    });

    expect(getRenders()).toBe(baseline);
  });
});

describe('useLayerData — a caller that mutates its layer configs in place', () => {
  // MDV's render-stack adapter keeps ONE `LayerConfig` object per stack entry and
  // patches it in place, so a cosmetic edit does not re-enter async geometry loads.
  // The `layers` record it hands over therefore keeps its identity across an edit —
  // which means config identity is NOT a "the load inputs changed" signal, and any
  // load the hook plans off that identity silently never happens.
  //
  // The symptom that got here: switching an already-loaded shapes/labels layer to a
  // different `fillColorByColumn` left the colours on the previous column forever.
  // The projection had no rows for the new column, so (correctly, per #119) it kept
  // serving the last-good entry — but nothing ever asked the resolver to load the
  // new column, so "last good" was all there would ever be.
  function tableSpatialData() {
    const columnValues: Record<string, string[]> = {
      region: ['cells', 'cells'],
      colA: ['a', 'a'],
      colB: ['b', 'b'],
    };
    const loadObsColumns = vi.fn(async (names: string[]) =>
      names.map((name) => columnValues[name] ?? [])
    );
    const table = {
      getTableKeys: () => ({ region: ['cells'], regionKey: 'region' }),
      loadObsIndex: vi.fn(async () => ['c1', 'c2']),
      loadObsColumns,
    };
    const spatialData = {
      getAssociatedTable: vi.fn(() => ['table', table]),
    } as unknown as SpatialData;
    return { spatialData, loadObsColumns };
  }

  /** Every column name the hook has asked the associated table for, in order. */
  const requestedColumns = (loadObsColumns: ReturnType<typeof vi.fn>): string[] =>
    loadObsColumns.mock.calls.flatMap((call) => call[0] as string[]);

  it('loads the new fill-colour column when a shapes config is switched in place', async () => {
    const { spatialData, loadObsColumns } = tableSpatialData();
    const elements: ElementsByType = { ...EMPTY_ELEMENTS, shapes: [shapesElement('cells')] };
    // ONE config object, ONE record — both keep their identity for the whole test,
    // exactly as they do under the render-stack adapter.
    const config: LayerConfig = {
      ...shapesConfig('layer-1', 'cells'),
      fillColorByColumn: { columnName: 'colA', mode: 'categorical' },
    };
    const layers = { 'layer-1': config };
    const layerOrder = Object.keys(layers);

    const { rerender } = renderHook(() =>
      useLayerData(layers, layerOrder, elements, null, spatialData)
    );

    await waitFor(() => {
      expect(requestedColumns(loadObsColumns)).toContain('colA');
    });

    // The switch the user makes in the panel: same config object, new column.
    config.fillColorByColumn = { columnName: 'colB', mode: 'categorical' };
    rerender();

    await waitFor(() => {
      expect(requestedColumns(loadObsColumns)).toContain('colB');
    });
  });

  it('loads the new fill-colour column when a labels config is switched in place', async () => {
    const { spatialData, loadObsColumns } = tableSpatialData();
    const labels: AvailableElement = {
      key: 'segmentation',
      type: 'labels',
      // The loader load will fail (no real zarr behind it) and that is fine: the
      // fill-colour column is a resource of its own and must load regardless.
      element: { key: 'segmentation' } as unknown as AvailableElement['element'],
      transform: new Matrix4(),
    };
    const elements: ElementsByType = { ...EMPTY_ELEMENTS, labels: [labels] };
    const config: LayerConfig = {
      id: 'layer-l',
      type: 'labels',
      elementKey: 'segmentation',
      visible: true,
      opacity: 1,
      fillColorByColumn: { columnName: 'colA', mode: 'categorical' },
    };
    const layers = { 'layer-l': config };
    const layerOrder = Object.keys(layers);

    const { rerender } = renderHook(() =>
      useLayerData(layers, layerOrder, elements, null, spatialData)
    );

    await waitFor(() => {
      expect(requestedColumns(loadObsColumns)).toContain('colA');
    });

    config.fillColorByColumn = { columnName: 'colB', mode: 'categorical' };
    rerender();

    await waitFor(() => {
      expect(requestedColumns(loadObsColumns)).toContain('colB');
    });
  });
});

describe('useLayerData — tile progress follows the LIVE layers', () => {
  /**
   * deck's `Tileset2D.finalize()` clears its tile cache WITHOUT firing `onTileUnload`,
   * which is the hook that prunes a layer's tile-status store. So a layer that stops
   * drawing tiles mid-request — hidden, removed, or switched to `pointsTiling: 'off'` —
   * leaves its last in-flight count behind in an append-only map. Aggregating that map
   * held the global spinner on for a layer that no longer exists.
   */
  const tilingMetadata = {
    kind: 'morton-points' as const,
    parquetPath: 'points/transcripts/points.parquet',
    axisNames: ['x', 'y'],
    featureCodeColumnName: 'feature_name_codes',
    mortonCodeColumnName: 'morton_code_2d',
    totalRows: 12_000,
    totalRowGroups: 8,
    maxRowsPerGroup: 2_000,
    supportsRowGroupRangeReads: true,
    bounds: { minX: 0, minY: 0, maxX: 1024, maxY: 1024 },
  };

  function tileablePointsElement(key: string): AvailableElement {
    const element = {
      key,
      getPointsTilingMetadata: vi.fn(async () => tilingMetadata),
      loadPointsInBounds: vi.fn(async () => null),
      loadPoints: vi.fn(async () => ({
        shape: [2, 1],
        data: [new Float32Array([0]), new Float32Array([0])],
      })),
      listFeaturesWithCounts: vi.fn(async () => null),
    } as unknown as PointsElement;
    return { key, type: 'points', element, transform: new Matrix4() };
  }

  const inFlightTile: PointsTileHandle = {
    tileId: '0-0--1',
    index: { x: 0, y: 0, z: -1 },
    bbox: { left: 0, top: 512, right: 512, bottom: 0 },
  };

  /** The store the hook handed to the layer — the only handle a caller ever gets. */
  function tileDebugStoreOf(layers: unknown[]): TileDebugStore | undefined {
    for (const layer of layers) {
      const store = (layer as { props?: { tileDebugStore?: TileDebugStore } }).props
        ?.tileDebugStore;
      if (store) return store;
    }
    return undefined;
  }

  it('drops a layer switched off tiling while a tile was still in flight', async () => {
    const elements: ElementsByType = {
      ...EMPTY_ELEMENTS,
      points: [tileablePointsElement('transcripts')],
    };
    const tiled = { ...pointsConfig('layer-p', 'transcripts'), pointsTiling: 'auto' as const };
    const { result, rerender } = renderHook(
      ({ layers }: { layers: Record<string, LayerConfig> }) =>
        useLayerData(layers, Object.keys(layers), elements, null),
      { initialProps: { layers: { 'layer-p': tiled } } }
    );

    await waitFor(() => {
      expect(result.current.pointsEngine.isTiled('transcripts')).toBe(true);
    });

    const store = tileDebugStoreOf(result.current.getLayers());
    expect(store).toBeDefined();

    // A tile enters the viewport and starts loading, and never settles — which is what
    // deck's finalize does to it, silently.
    act(() => {
      const hooks = createTiledPointsDebugHooks(store);
      hooks.onViewportTilesRequested([inFlightTile]);
      hooks.onTileLoadStart(inFlightTile);
    });
    await waitFor(() => {
      expect(result.current.isLoading).toBe(true);
    });

    rerender({ layers: { 'layer-p': { ...tiled, pointsTiling: 'off' as const } } });

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });
  });

  it('drops a layer removed while a tile was still in flight', async () => {
    const elements: ElementsByType = {
      ...EMPTY_ELEMENTS,
      points: [tileablePointsElement('transcripts')],
    };
    const tiled = { ...pointsConfig('layer-p', 'transcripts'), pointsTiling: 'auto' as const };
    const { result, rerender } = renderHook(
      ({ layers }: { layers: Record<string, LayerConfig> }) =>
        useLayerData(layers, Object.keys(layers), elements, null),
      { initialProps: { layers: { 'layer-p': tiled } } }
    );

    await waitFor(() => {
      expect(result.current.pointsEngine.isTiled('transcripts')).toBe(true);
    });
    const store = tileDebugStoreOf(result.current.getLayers());
    act(() => {
      const hooks = createTiledPointsDebugHooks(store);
      hooks.onViewportTilesRequested([inFlightTile]);
      hooks.onTileLoadStart(inFlightTile);
    });
    await waitFor(() => {
      expect(result.current.isLoading).toBe(true);
    });

    rerender({ layers: {} });

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });
  });
});
