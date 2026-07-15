import { Matrix4 } from '@math.gl/core';
import { describe, expect, it, vi } from 'vitest';
import {
  type PointsResolveConfig,
  PointsResolver,
  Resolution,
  type ResolveContext,
  SpatialEntryStore,
} from '../src/engine/index.js';
import type { PointsElement } from '../src/models/index.js';
import type { PointsLoadResult } from '../src/pointsLoadOptions.js';

/**
 * The points Resource Resolver, driven headless.
 *
 * **This file IS the "resolver is exercised by a test that constructs no deck
 * layer and no GL context" box in ADR 0004's definition of done.** It imports
 * nothing from `layers` or `vis`, renders nothing, and touches no canvas — which
 * is exactly what `tgpu-htj2k` needs to be true in order to consume this at all.
 *
 * The behavioural surface (cache, dedup, cap handling, catalog supersession, the
 * dict-only remap) is already pinned in far more detail by
 * `layers/tests/pointsDataEngine.spec.ts`, which must keep passing UNCHANGED
 * through the split — that spec is the real regression net. What this file adds is
 * the parts that are NEW: the plan/load phase separation, and the Resolution-shaped
 * snapshot.
 */

const batch = (pointCount: number, over: Partial<PointsLoadResult> = {}): PointsLoadResult => ({
  shape: [2, pointCount],
  data: [
    new Float32Array(Array.from({ length: pointCount }, (_, i) => i)),
    new Float32Array(Array.from({ length: pointCount }, (_, i) => i)),
  ],
  featureCodes: new Int32Array(Array.from({ length: pointCount }, (_, i) => i % 2)),
  hasFeatureCodeColumn: true,
  ...over,
});

function element(over: Partial<Record<string, unknown>> = {}) {
  return {
    key: 'transcripts',
    loadPoints: vi.fn(async () => batch(4)),
    listFeaturesWithCounts: vi.fn(async () => null),
    loadRowFeatureCodes: vi.fn(async () => new Int32Array([0, 1, 0, 1])),
    loadPointsMatchingFeatureCodes: vi.fn(async () => batch(2)),
    ...over,
  } as unknown as PointsElement;
}

const ctx = (
  el: PointsElement,
  config: PointsResolveConfig = {}
): ResolveContext<PointsResolveConfig, PointsElement> => ({
  entryId: 'layer-p',
  elementKey: 'transcripts',
  kind: 'points',
  element: el,
  config,
  transform: new Matrix4(),
});

describe('plan() — pure, synchronous, starts nothing', () => {
  // The load-bearing claim of the whole phase separation. Two of these conditions
  // used to be evaluated inside getLayers() DURING RENDER and kicked with a bare
  // `void engine.ensureX(...)`. They were always pure functions of config + entry
  // state; they were being asked in the wrong phase. Now they cannot start work.
  it('does not touch the element', () => {
    const el = element();
    const resolver = new PointsResolver();

    resolver.plan(ctx(el, { featureCodes: [0, 1], colorByFeature: true }));

    expect(el.loadPoints).not.toHaveBeenCalled();
    expect(el.loadRowFeatureCodes).not.toHaveBeenCalled();
    expect(el.loadPointsMatchingFeatureCodes).not.toHaveBeenCalled();
  });

  it('plans a preload for a fresh entry', () => {
    const tasks = new PointsResolver().plan(ctx(element()));

    expect(tasks.map((t) => t.resource)).toEqual(['preload']);
  });

  it('puts the memory cap IN the task id, so a cap change supersedes rather than dedups', () => {
    const resolver = new PointsResolver();

    const at4m = resolver.plan(ctx(element(), { pointsMemoryCap: 4_000_000 }))[0];
    const at8m = resolver.plan(ctx(element(), { pointsMemoryCap: 8_000_000 }))[0];

    // Same id ⇒ dedup; different id ⇒ supersede. R3 is the matching path getting
    // exactly this wrong — dedup on signature alone, ignoring the cap entirely.
    expect(at4m?.id).not.toBe(at8m?.id);
    expect(at4m?.id).toContain('4000000');
  });

  it('plans rowCodes only when a filter or colour-by-feature needs them', () => {
    const resolver = new PointsResolver();
    const resources = (config: PointsResolveConfig) =>
      resolver.plan(ctx(element(), config)).map((t) => t.resource);

    expect(resources({})).not.toContain('rowCodes');
    expect(resources({ colorByFeature: true })).toContain('rowCodes');
    expect(resources({ featureCodes: [0] })).toContain('rowCodes');
    // An empty selection is "no filter", not "filter to nothing".
    expect(resources({ featureCodes: [] })).not.toContain('rowCodes');
  });

  it('plans a matching scan only once the element is known to support one', async () => {
    const resolver = new PointsResolver();
    const el = element();
    const config: PointsResolveConfig = { featureCodes: [0] };

    // Before anything loads we cannot know whether a scan is even possible.
    expect(resolver.plan(ctx(el, config)).map((t) => t.resource)).not.toContain('matching');

    await resolver.ensureLoaded({ key: 'transcripts', layerId: 'layer-p', element: el });

    expect(resolver.plan(ctx(el, config)).map((t) => t.resource)).toContain('matching');
  });

  it('stops planning a preload once one is resident', async () => {
    const resolver = new PointsResolver();
    const el = element();

    await resolver.load(
      { id: 'x', resource: 'preload', payload: { memoryCap: 4_000_000 } },
      ctx(el),
      new AbortController().signal
    );

    expect(resolver.plan(ctx(el, { pointsMemoryCap: 4_000_000 })).map((t) => t.resource)).toEqual(
      []
    );
  });
});

describe('load() — the only place I/O starts', () => {
  it('dispatches each task to its lifecycle method', async () => {
    const resolver = new PointsResolver();
    const el = element();
    const signal = new AbortController().signal;

    await resolver.load({ id: 'a', resource: 'preload' }, ctx(el), signal);
    expect(el.loadPoints).toHaveBeenCalledTimes(1);

    await resolver.load({ id: 'b', resource: 'catalog' }, ctx(el), signal);
    expect(el.listFeaturesWithCounts).toHaveBeenCalledTimes(1);

    await resolver.load(
      { id: 'c', resource: 'matching', payload: { featureCodes: [0] } },
      ctx(el),
      signal
    );
    expect(el.loadPointsMatchingFeatureCodes).toHaveBeenCalledTimes(1);
  });

  it('ignores an unknown resource rather than throwing', async () => {
    const resolver = new PointsResolver();

    await expect(
      resolver.load({ id: 'z', resource: 'nonsense' }, ctx(element()), new AbortController().signal)
    ).resolves.toBeUndefined();
  });
});

describe('snapshot() — per-resource resolutions, identity-stable', () => {
  it('is idle before anything is planned', () => {
    const snapshot = new PointsResolver().snapshot(ctx(element()));

    expect(Resolution.isIdle(snapshot.resources.preload as never)).toBe(true);
    expect(snapshot.notices).toEqual([]);
  });

  it('reports the resident batch as ready, by reference', async () => {
    const resolver = new PointsResolver();
    const el = element();
    await resolver.ensureLoaded({ key: 'transcripts', layerId: 'layer-p', element: el });

    const snapshot = resolver.snapshot(ctx(el));

    expect(Resolution.readyValue(snapshot.resources.preload as never)).toBe(
      resolver.getData('transcripts')
    );
  });

  it('returns the SAME object until something mutates — an adapter memoises on this', async () => {
    const resolver = new PointsResolver();
    const el = element();
    // ONE context, reused — the hook memoises AvailableElement (transform included)
    // on [spatialData, coordinateSystem], so a given entry sees a stable ctx across
    // renders. Repeated calls stand in for repeated renders (pan, hover, viewState).
    const c = ctx(el);
    await resolver.ensureLoaded({ key: 'transcripts', layerId: 'layer-p', element: el });

    const first = resolver.snapshot(c);

    // Ten "renders" with no state change. A fresh object here is a deck teardown
    // per frame — the pan flash, one layer up.
    for (let i = 0; i < 10; i++) {
      expect(resolver.snapshot(c)).toBe(first);
    }
  });

  it('returns a NEW object once state changes', async () => {
    const resolver = new PointsResolver();
    const el = element();
    const c = ctx(el);
    await resolver.ensureLoaded({ key: 'transcripts', layerId: 'layer-p', element: el });
    const before = resolver.snapshot(c);

    await resolver.ensureFeatureCatalog({ key: 'transcripts', layerId: 'layer-p', element: el });
    const after = resolver.snapshot(c);

    expect(after).not.toBe(before);
  });

  it('gives two entries sharing one element DISTINCT snapshots', async () => {
    // elementKey is the cache key; several layers may share one. The memo must not
    // hand entry B the snapshot it built for entry A — entryId and all.
    const resolver = new PointsResolver();
    const el = element();
    await resolver.ensureLoaded({ key: 'transcripts', layerId: 'layer-a', element: el });
    // Same element, same transform — the ONLY difference is the entry (layer).
    const base = ctx(el);

    const a = resolver.snapshot({ ...base, entryId: 'layer-a' });
    const b = resolver.snapshot({ ...base, entryId: 'layer-b' });

    expect(a.entryId).toBe('layer-a');
    expect(b.entryId).toBe('layer-b');
    expect(a).not.toBe(b);
    // ...but each is still stable on its own.
    expect(resolver.snapshot({ ...base, entryId: 'layer-a' })).toBe(a);
  });

  it('refreshes the snapshot when the selection changes — it drives the notice', async () => {
    // featureCodes is part of the memo key because the truncation notice depends on it.
    const resolver = new PointsResolver();
    const el = element();
    await resolver.ensureLoaded({ key: 'transcripts', layerId: 'layer-p', element: el });

    const none = resolver.snapshot(ctx(el, {}));
    const filtered = resolver.snapshot(ctx(el, { featureCodes: [0] }));

    expect(filtered).not.toBe(none);
  });

  it('keeps a failed resource from blanking a healthy one — failure is PER-RESOURCE', async () => {
    // A points entry whose catalog scan fails must still draw its geometry. That is
    // the whole reason there is no entry-wide Result.
    const resolver = new PointsResolver();
    const el = element({
      listFeaturesWithCounts: vi.fn(async () => {
        throw new Error('catalog scan exploded');
      }),
    });
    vi.spyOn(console, 'error').mockImplementation(() => {});

    await resolver.ensureLoaded({ key: 'transcripts', layerId: 'layer-p', element: el });
    await resolver.ensureFeatureCatalog({ key: 'transcripts', layerId: 'layer-p', element: el });

    const snapshot = resolver.snapshot(ctx(el));

    expect(Resolution.isReady(snapshot.resources.preload as never)).toBe(true);
    expect(Resolution.readyValue(snapshot.resources.catalog as never)).toBeNull();
  });

  it('carries `stale` through a cap raise, so the old batch keeps drawing', async () => {
    const resolver = new PointsResolver();
    let resolveSecond!: (b: PointsLoadResult) => void;
    let call = 0;
    const el = element({
      loadPoints: vi.fn(async () => {
        call += 1;
        if (call === 1) return batch(4, { preloadTruncated: true, totalRowCount: 100 });
        return new Promise<PointsLoadResult>((r) => {
          resolveSecond = r;
        });
      }),
    });
    const target = { key: 'transcripts', layerId: 'layer-p', element: el };

    await resolver.ensureLoaded(target, 4);
    const settled = resolver.getData('transcripts');

    // Raise the cap past a truncated batch → a real reload, still in flight.
    const pending = resolver.ensureLoaded(target, 8);
    const midFlight = resolver.snapshot(ctx(el));

    const preload = midFlight.resources.preload as never;
    expect(Resolution.isLoading(preload)).toBe(true);
    // The atomic swap: the previous batch is retained and still drawable.
    expect(Resolution.lastGood(preload)).toBe(settled);

    resolveSecond(batch(8));
    await pending;
  });

  it('surfaces a truncated preload as a NOTICE, not an error — healthy data with a caveat', async () => {
    const resolver = new PointsResolver();
    const el = element({
      loadPoints: vi.fn(async () => batch(4, { preloadTruncated: true, totalRowCount: 1_000_000 })),
    });

    await resolver.ensureLoaded({ key: 'transcripts', layerId: 'layer-p', element: el }, 4);
    const snapshot = resolver.snapshot(ctx(el));

    expect(Resolution.isReady(snapshot.resources.preload as never)).toBe(true);
    expect(snapshot.notices).toEqual([
      expect.objectContaining({ kind: 'preload-truncated', loaded: 4, total: 1_000_000 }),
    ]);
  });
});

describe('SpatialEntryStore — the reconcile loop', () => {
  const store = (resolver: PointsResolver) =>
    new SpatialEntryStore({
      points: resolver,
      // Step 1 registers all four; only points is exercised here.
      shapes: resolver,
      images: resolver,
      labels: resolver,
    });

  it('plans and loads in one pass', async () => {
    const resolver = new PointsResolver();
    const el = element();

    await store(resolver).reconcile([ctx(el)]);

    expect(el.loadPoints).toHaveBeenCalledTimes(1);
    expect(resolver.hasData('transcripts')).toBe(true);
  });

  it('is idempotent — a second reconcile with nothing changed does no I/O', async () => {
    const resolver = new PointsResolver();
    const el = element();
    const s = store(resolver);

    await s.reconcile([ctx(el)]);
    await s.reconcile([ctx(el)]);

    expect(el.loadPoints).toHaveBeenCalledTimes(1);
  });

  it('blocks on the preload, and stops blocking once it is drawable', async () => {
    const resolver = new PointsResolver();
    const el = element();
    const s = store(resolver);

    expect(s.isBlocking(ctx(el))).toBe(true);

    await s.reconcile([ctx(el)]);

    expect(s.isBlocking(ctx(el))).toBe(false);
  });

  it('does not block on a resource that is merely refining', async () => {
    // A catalog scan or a feature scan refines an already-drawable layer. Only the
    // preload gates a first paint — and blockingResources says so as DATA, which is
    // what today's isBlocking kind-switch collapses into.
    const resolver = new PointsResolver();

    expect(resolver.blockingResources).toEqual(['preload']);
  });

  it('bumps its version when any resolver mutates', async () => {
    const resolver = new PointsResolver();
    const s = store(resolver);
    const before = s.getVersion();

    await s.reconcile([ctx(element())]);

    expect(s.getVersion()).toBeGreaterThan(before);
  });
});
