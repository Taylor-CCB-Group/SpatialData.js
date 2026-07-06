import { describe, expect, it, vi } from 'vitest';

import { PointsDataEngine } from '../src/engine/PointsDataEngine.js';
import type { PointsElement, PointsLoadResult } from '@spatialdata/core';

function makeBatch(): PointsLoadResult {
  return {
    shape: [3, 2],
    data: [new Float32Array([0, 1, 2]), new Float32Array([0, 1, 2])],
  };
}

/** Minimal PointsElement stub: only `key` and `loadPoints` are exercised by the
 * preloaded path. `loadPoints` is a spy so we can assert idempotent loading. */
function makeElement(key: string, batch = makeBatch()) {
  const loadPoints = vi.fn(async () => batch);
  return { element: { key, loadPoints } as unknown as PointsElement, loadPoints };
}

describe('PointsDataEngine', () => {
  it('loads once, reports status, and caches the batch', async () => {
    const statuses: Array<[string, string]> = [];
    const engine = new PointsDataEngine({
      onStatus: (layerId, status) => statuses.push([layerId, status]),
    });
    const { element } = makeElement('pts:a');

    expect(engine.hasData('pts:a')).toBe(false);
    expect(engine.getStatus('pts:a')).toBe('idle');

    await engine.ensureLoaded({ key: 'pts:a', layerId: 'layer-a', element });

    expect(engine.hasData('pts:a')).toBe(true);
    expect(engine.getStatus('pts:a')).toBe('ready');
    expect(engine.getData('pts:a')?.data[0]).toHaveLength(3);
    expect(statuses).toEqual([
      ['layer-a', 'loading'],
      ['layer-a', 'ready'],
    ]);
  });

  it('is idempotent: concurrent loads trigger a single loadPoints', async () => {
    const engine = new PointsDataEngine();
    const { element, loadPoints } = makeElement('pts:b');

    const p1 = engine.ensureLoaded({ key: 'pts:b', layerId: 'l', element });
    const p2 = engine.ensureLoaded({ key: 'pts:b', layerId: 'l', element });
    await Promise.all([p1, p2]);
    // A third call after settle is a no-op too.
    await engine.ensureLoaded({ key: 'pts:b', layerId: 'l', element });

    expect(loadPoints).toHaveBeenCalledTimes(1);
  });

  it('memoizes a stable render resource (the pan-flash guard)', async () => {
    const engine = new PointsDataEngine();
    const { element } = makeElement('pts:c');

    expect(engine.getResource(element, 'pts:c')).toBeNull(); // no data yet
    await engine.ensureLoaded({ key: 'pts:c', layerId: 'l', element });

    const r1 = engine.getResource(element, 'pts:c');
    const r2 = engine.getResource(element, 'pts:c');
    expect(r1).toBeTruthy();
    // Same identity across calls: a fresh loader each render would reset the
    // composite and blank the layer for a frame.
    expect(r1).toBe(r2);
    expect(r1?.loader).toBe(r2?.loader);
  });

  it('reports error status when loadPoints rejects', async () => {
    const statuses: string[] = [];
    const engine = new PointsDataEngine({ onStatus: (_l, s) => statuses.push(s) });
    const element = {
      key: 'pts:d',
      loadPoints: vi.fn(async () => {
        throw new Error('boom');
      }),
    } as unknown as PointsElement;
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await engine.ensureLoaded({ key: 'pts:d', layerId: 'l', element });

    expect(engine.getStatus('pts:d')).toBe('error');
    expect(engine.hasData('pts:d')).toBe(false);
    expect(statuses).toEqual(['loading', 'error']);
    errSpy.mockRestore();
  });

  it('evict clears cached data and resource', async () => {
    const engine = new PointsDataEngine();
    const { element } = makeElement('pts:e');
    await engine.ensureLoaded({ key: 'pts:e', layerId: 'l', element });
    expect(engine.getResource(element, 'pts:e')).toBeTruthy();

    engine.evict('pts:e');

    expect(engine.hasData('pts:e')).toBe(false);
    expect(engine.getResource(element, 'pts:e')).toBeNull();
  });

  it('notifies subscribers when a load settles', async () => {
    const engine = new PointsDataEngine();
    const { element } = makeElement('pts:f');
    const listener = vi.fn();
    const unsubscribe = engine.subscribe(listener);

    await engine.ensureLoaded({ key: 'pts:f', layerId: 'l', element });
    expect(listener).toHaveBeenCalledTimes(1);

    unsubscribe();
    engine.evict('pts:f');
    await engine.ensureLoaded({ key: 'pts:f', layerId: 'l', element });
    expect(listener).toHaveBeenCalledTimes(1); // no longer subscribed
  });
});
