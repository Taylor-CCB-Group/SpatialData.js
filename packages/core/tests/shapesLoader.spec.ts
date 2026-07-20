import { describe, expect, it, vi } from 'vitest';
import type { ShapesElement } from '../src/models/index.js';
import type { SpatialBounds } from '../src/pointsTiling.js';
import type { ShapesRenderData } from '../src/shapes.js';
import {
  createFullShapesLoader,
  createShapesLoaderForElement,
  resolveShapesEncoding,
} from '../src/shapesLoader.js';

/**
 * The shapes loader seam, Phase 0. The claims that matter are the *honesty* ones:
 * the `wkb-full` loader must report that it does not tile, must return the whole
 * element rather than pretend to filter by bounds, and must hold no state of its
 * own — the mutable lifecycle lives in the resolver, not here. These are the
 * exact properties that keep the points-style concurrency bugs out of the loader.
 */

const renderData = (): ShapesRenderData => ({
  kind: 'js-polygons',
  geometryKind: 'circle',
  elementKey: 'cells',
  featureIds: ['c1', 'c2'],
  circles: {
    positions: [new Float32Array([0, 10]), new Float32Array([0, 10])],
    radii: new Float32Array([1, 1]),
  },
  rowIndexByFeatureIndex: new Int32Array([0, 1]),
});

function element(over: Record<string, unknown> = {}) {
  return {
    key: 'cells',
    loadRenderData: vi.fn(async () => renderData()),
    ...over,
  } as unknown as ShapesElement;
}

const bounds: SpatialBounds = { minX: 0, minY: 0, maxX: 5, maxY: 5 };

describe('createFullShapesLoader', () => {
  it('advertises that it does not tile', () => {
    const loader = createFullShapesLoader(element());
    expect(loader.capabilities.kind).toBe('wkb-full');
    expect(loader.capabilities.batchFormat).toBe('decoded-render-data');
    expect(loader.capabilities.supportsViewportTiles).toBe(false);
    // Nothing is loaded at construction, so bounds are unknown — the resolver
    // computes them from the geometry, not the loader.
    expect(loader.capabilities.bounds).toBeUndefined();
  });

  it('returns the whole element from loadInBounds, ignoring bounds honestly', async () => {
    const el = element();
    const loader = createFullShapesLoader(el);

    const batch = await loader.loadInBounds({ bounds });
    expect(batch).not.toBeNull();
    expect(batch?.format).toBe('decoded-render-data');
    expect(batch?.renderData.featureIds).toEqual(['c1', 'c2']);
    // A full loader carries no per-request bounds — the batch IS the element.
    expect(batch?.bounds).toBeUndefined();
  });

  it('loadAll returns the same batch shape as loadInBounds', async () => {
    const loader = createFullShapesLoader(element());
    const all = await loader.loadAll?.();
    expect(all?.format).toBe('decoded-render-data');
    expect(all?.renderData.featureIds).toEqual(['c1', 'c2']);
  });

  it('is stateless: it caches nothing and delegates every call to the element', async () => {
    const el = element();
    const loader = createFullShapesLoader(el);

    await loader.loadInBounds({ bounds });
    await loader.loadInBounds({ bounds });
    await loader.loadAll?.();

    // No memoisation in the loader — three calls, three delegations. Caching is
    // the resolver's / element's job; a second cache here is exactly the kind of
    // duplicated mutable state the points passes had to untangle.
    expect(el.loadRenderData).toHaveBeenCalledTimes(3);
  });

  it('surfaces an already-aborted signal as a rejection', async () => {
    const el = element();
    const loader = createFullShapesLoader(el);

    await expect(loader.loadInBounds({ bounds, signal: AbortSignal.abort() })).rejects.toThrow();
    // Aborted before it started — the element is never touched.
    expect(el.loadRenderData).not.toHaveBeenCalled();
  });
});

describe('createShapesLoaderForElement / resolveShapesEncoding', () => {
  it('resolves to the full WKB loader in Phase 0', () => {
    expect(resolveShapesEncoding()).toBe('wkb-full');
    const loader = createShapesLoaderForElement(element());
    expect(loader.capabilities.kind).toBe('wkb-full');
  });
});
