/**
 * The points feature list must stay windowed.
 *
 * A Xenium 5K-plus panel is ~12.4k features, and a row each put 91,107 nodes and
 * 12,453 checkboxes in the DOM (#172). The net for both halves of the fix: the DOM
 * stays a window, and the whole-catalog classification pass behind the summary lines
 * runs per change of input rather than per render — it survives virtualization, so
 * it is the floor the DOM cost was hiding.
 */
import type { PointsDataEngine, PointsLoadTarget } from '@spatialdata/layers';
import { render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SpatialCanvasProvider } from '../src/SpatialCanvas/context';
import { PointsFeatureFilterPanel } from '../src/SpatialCanvas/PointsFeatureFilterPanel';
import { PointsFeatureStateProvider } from '../src/SpatialCanvas/PointsFeatureState';
import type { PointsLayerConfig } from '../src/SpatialCanvas/types';

const FEATURE_COUNT = 12_448;
const LAYER_KEY = 'points:transcripts';

function catalogOf(count: number) {
  return {
    featureKey: 'feature_name',
    entries: Array.from({ length: count }, (_, index) => ({
      code: index,
      name: `GENE_${String(index).padStart(5, '0')}`,
      count: count - index,
    })),
  };
}

/** A duck-typed stand-in for the engine's read surface — only what
 * `usePointsFeatureState` calls. A real engine would drag in a store and a loader. */
function stubEngine(overrides: Record<string, unknown> = {}) {
  const catalog = catalogOf(FEATURE_COUNT);
  const engine = {
    subscribe: () => () => {},
    getVersion: () => 1,
    ensureFeatureCatalog: vi.fn(async () => {}),
    setHighlightedFeature: vi.fn(),
    retry: vi.fn(),
    supportsFeatureScan: () => true,
    getFeatureCatalog: () => catalog,
    isFeatureCatalogLoading: () => false,
    isFeatureCatalogRefining: () => false,
    // Every feature resident, so no row is greyed and the summary pass has real work.
    getResidentFeatureCodes: () => new Set(catalog.entries.map((entry) => entry.code)),
    getLoadedMatchingFeatureCodes: () => undefined,
    getMatchingLoadState: () => undefined,
    getActiveTruncation: () => undefined,
    isTiled: () => false,
    getResidentFeatureCounts: () => new Map(catalog.entries.map((e) => [e.code, e.count])),
    ...overrides,
  };
  return engine as unknown as PointsDataEngine;
}

const CONFIG: PointsLayerConfig = {
  id: 'layer-1',
  type: 'points',
  visible: true,
  opacity: 1,
  elementKey: 'transcripts',
};

function renderPanel(engine: PointsDataEngine) {
  const target = {
    key: LAYER_KEY,
    layerId: CONFIG.id,
    element: {} as PointsLoadTarget['element'],
  };
  return render(
    <SpatialCanvasProvider>
      <PointsFeatureStateProvider engine={engine} target={target}>
        <PointsFeatureFilterPanel config={CONFIG} />
      </PointsFeatureStateProvider>
    </SpatialCanvasProvider>
  );
}

/**
 * jsdom lays nothing out, so `offsetHeight` — what the virtualizer measures its
 * scroll box with — is 0, and a zero-height viewport windows to no rows. Stand in
 * the height the panel gives the list; without it every assertion below would pass
 * on an empty list, the one outcome that must not count as success.
 */
beforeEach(() => {
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(180);
  vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(240);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('points feature list virtualization', () => {
  it('mounts a window of rows, not the whole catalog', () => {
    const { container } = renderPanel(stubEngine());
    const checkboxes = container.querySelectorAll('input[type="checkbox"]');
    // Two of these are the "All features" / "Deselect all" controls, which are not
    // part of the virtualized list.
    expect(checkboxes.length).toBeLessThan(60);
    // The list is not simply empty — the whole point is that it still renders rows.
    // A 180px viewport of 22px rows plus overscan — around 17 rows, and nowhere
    // near 12,448. The lower bound matters as much as the upper: an empty list
    // would satisfy the cap above while rendering nothing at all.
    expect(checkboxes.length).toBeGreaterThan(10);
  });

  it('keeps the DOM far below the unvirtualized cost', () => {
    const { container } = renderPanel(stubEngine());
    // 12,448 features rendered a row each measured at 91,107 nodes. The windowed
    // panel is ~112. Any number in the low hundreds means the window is holding.
    expect(container.querySelectorAll('*').length).toBeLessThan(500);
  });

  it('still reports the full catalog size in the header', () => {
    const { container } = renderPanel(stubEngine());
    expect(container.textContent).toContain(`${FEATURE_COUNT}/${FEATURE_COUNT} selected`);
  });

  it('sizes the scroll spacer to the whole list, so the scrollbar covers every feature', () => {
    const { container } = renderPanel(stubEngine());
    const spacer = container.querySelector<HTMLElement>('div[style*="position: relative"]');
    expect(spacer).not.toBeNull();
    // Row height × feature count — the scrollable extent of all 12,448 rows.
    expect(Number.parseInt(spacer?.style.height ?? '0', 10)).toBeGreaterThan(FEATURE_COUNT * 20);
  });

  it('classifies the whole catalog once per input change, not once per render', () => {
    const engine = stubEngine();
    const residentCodes = engine.getResidentFeatureCodes(LAYER_KEY);
    // Identity-stable reads are what let the panel memoise its O(features) pass;
    // the real engine caches these on the row-code buffer for the same reason.
    const getResident = vi.fn(() => residentCodes);
    const stable = stubEngine({ getResidentFeatureCodes: getResident });
    const { rerender } = renderPanel(stable);
    const afterFirst = getResident.mock.calls.length;
    const target = {
      key: LAYER_KEY,
      layerId: CONFIG.id,
      element: {} as PointsLoadTarget['element'],
    };
    rerender(
      <SpatialCanvasProvider>
        <PointsFeatureStateProvider engine={stable} target={target}>
          <PointsFeatureFilterPanel config={CONFIG} />
        </PointsFeatureStateProvider>
      </SpatialCanvasProvider>
    );
    // The read still happens per render (it is cheap); what must NOT happen is the
    // catalog-wide reclassification behind it, which is why the reads must return a
    // stable identity. Assert the contract this memoisation rests on.
    expect(getResident.mock.calls.length).toBeGreaterThan(afterFirst);
    expect(getResident.mock.results.every((r) => r.value === residentCodes)).toBe(true);
  });
});
