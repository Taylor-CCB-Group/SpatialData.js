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
    // A4: a failed full-catalog scan is a retryable `failed`, not a permanent
    // null-settle — and it must not blank the healthy preload beside it.
    const catalog = snapshot.resources.catalog;
    expect(Resolution.isFailed(catalog as never)).toBe(true);
    if (catalog.status === 'failed') {
      expect(catalog.error.retryable).toBe(true);
    }
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

describe('Track A — races closed by the slot keys', () => {
  /** An element whose preload settlements you control per memory cap. */
  function deferredPreloadElement() {
    const release = new Map<number, (value: PointsLoadResult) => void>();
    const loadPoints = vi.fn(
      (opts: { memoryCap: number; signal?: AbortSignal }) =>
        new Promise<PointsLoadResult>((resolve, reject) => {
          release.set(opts.memoryCap, resolve);
          opts.signal?.addEventListener('abort', () =>
            reject(new DOMException('aborted', 'AbortError'))
          );
        })
    );
    const loadRowFeatureCodes = vi.fn(async () => new Int32Array([0, 1, 0, 1]));
    const el = {
      key: 'transcripts',
      loadPoints,
      loadRowFeatureCodes,
      listFeaturesWithCounts: vi.fn(async () => null),
    } as unknown as PointsElement;
    return { el, loadPoints, loadRowFeatureCodes, release };
  }

  const target = (el: PointsElement) => ({ key: 'transcripts', layerId: 'L', element: el });

  it('R1: a cap drag 4M→8M→4M does not wipe the live load, so a redundant request dedups', async () => {
    // The old bug: superseding 4M→8M→4M left the *first* 4M load's `finally` to run
    // with `entry.memoryCap === 4M` (the final cap), so it cleared the LIVE final
    // load's markers. A subsequent 4M request then failed to dedup and kicked a
    // SECOND concurrent decode. Record-identity supersession forbids this.
    const resolver = new PointsResolver();
    const { el, loadPoints, release } = deferredPreloadElement();

    const p4a = resolver.ensureLoaded(target(el), 4_000_000); // decode #1 (4M)
    const p8 = resolver.ensureLoaded(target(el), 8_000_000); //  decode #2 (8M), aborts #1
    const p4b = resolver.ensureLoaded(target(el), 4_000_000); // decode #3 (4M), aborts #2

    // Let the superseded first 4M load's rejection + continuation run — this is where
    // the old `finally` wiped the live load's markers.
    await p4a;

    // A redundant 4M request must dedup to the live decode #3, NOT start a fourth.
    const p4c = resolver.ensureLoaded(target(el), 4_000_000);
    expect(loadPoints).toHaveBeenCalledTimes(3);

    release.get(4_000_000)?.(batch(4));
    await Promise.all([p4b, p4c]);
    expect(resolver.getData('transcripts')?.shape[1]).toBe(4);
    await Promise.allSettled([p8]);
  });

  it('R5: row codes are read at the resident preload cap, not the 4M default', async () => {
    // The old bug: `ensureRowFeatureCodes` took no cap, so it read 4M rows while an
    // 8M preload was resident → index i in the codes named a different row than
    // point i in the batch → a corrupted filter mask. Keying the rowCodes slot on the
    // preload's cap is the fix.
    const resolver = new PointsResolver();
    const { el, loadRowFeatureCodes, release } = deferredPreloadElement();

    // Preload in flight at 8M (pendingKey = 8M).
    const preload = resolver.ensureLoaded(target(el), 8_000_000);
    // Filter toggled mid-preload → the codes must be read at the SAME 8M window.
    await resolver.ensureRowFeatureCodes(target(el));

    expect(loadRowFeatureCodes).toHaveBeenCalledWith(
      expect.objectContaining({ memoryCap: 8_000_000 })
    );
    release.get(8_000_000)?.(batch(8));
    await preload;
  });

  /** An element whose feature-index scans you settle per call. */
  function deferredScanElement() {
    const calls: Array<{
      featureCodes: number[];
      memoryCap: number;
      resolve: (result: PointsLoadResult) => void;
    }> = [];
    const loadPointsMatchingFeatureCodes = vi.fn(
      (opts: { featureCodes: readonly number[]; memoryCap: number }) =>
        new Promise<PointsLoadResult>((resolve) => {
          calls.push({ featureCodes: [...opts.featureCodes], memoryCap: opts.memoryCap, resolve });
        })
    );
    const el = {
      key: 'transcripts',
      loadPoints: vi.fn(async () => batch(4)), // hasFeatureCodeColumn: true → authoritative
      loadPointsMatchingFeatureCodes,
    } as unknown as PointsElement;
    return { el, loadPointsMatchingFeatureCodes, calls };
  }

  it('R2: a superseded scan cannot corrupt the reselected one ({0,1}→{2}→{0,1})', async () => {
    // The old bug: rapid selection changes left two scans with the SAME signature
    // running concurrently (the first, and the reselected third), both writing the
    // one shared matchingLoading marker — so the superseded first scan's `finally`
    // could clobber the live third's result. Record-identity supersession forbids it.
    const resolver = new PointsResolver();
    const { el, loadPointsMatchingFeatureCodes, calls } = deferredScanElement();
    const t = { key: 'transcripts', layerId: 'L', element: el };
    await resolver.ensureLoaded(t);

    resolver.ensureMatchingFeaturesLoaded(t, [0, 1]); // scan A
    resolver.ensureMatchingFeaturesLoaded(t, [2]); //    scan B (supersedes A)
    const pC = resolver.ensureMatchingFeaturesLoaded(t, [0, 1]); // scan C (supersedes B)
    expect(loadPointsMatchingFeatureCodes).toHaveBeenCalledTimes(3);

    const resultA = batch(9, { featureCodes: new Int32Array([0, 1, 0, 1, 0, 1, 0, 1, 0]) });
    const resultC = batch(3, { featureCodes: new Int32Array([0, 1, 0]) });
    // The superseded first scan settles FIRST — in the old engine this is where it
    // wrote resultA over the live scan's marker.
    calls[0].resolve(resultA);
    await Promise.resolve();
    // The live reselected scan settles.
    calls[2].resolve(resultC);
    await pC;

    expect(resolver.getMatchedBatch('transcripts')).toBe(resultC);
    calls[1].resolve(batch(1)); // drain the superseded {2} scan
  });

  it('R3: raising the cap during a scan supersedes it, not served by the smaller one', async () => {
    // The old bug: a cap raise for the same selection was "covered" by the in-flight
    // smaller scan and deduped to it, so the extra rows were never fetched. The cap
    // is in the slot key, so it supersedes.
    const resolver = new PointsResolver();
    const { el, loadPointsMatchingFeatureCodes, calls } = deferredScanElement();
    const t = { key: 'transcripts', layerId: 'L', element: el };
    await resolver.ensureLoaded(t, 4_000_000);

    resolver.ensureMatchingFeaturesLoaded(t, [0], 4_000_000); // scan at 4M
    const p8 = resolver.ensureMatchingFeaturesLoaded(t, [0], 8_000_000); // raise → supersede

    expect(loadPointsMatchingFeatureCodes).toHaveBeenCalledTimes(2);
    expect(calls[1]?.memoryCap).toBe(8_000_000);

    calls[1].resolve(batch(6));
    await p8;
    calls[0].resolve(batch(3)); // drain the superseded 4M scan
  });
});

describe('Track A — retryable failures', () => {
  it('a failed full-catalog scan is retryable, and retry() re-runs it', async () => {
    const resolver = new PointsResolver();
    let attempts = 0;
    const el = element({
      listFeaturesWithCounts: vi.fn(async () => {
        attempts += 1;
        if (attempts === 1) throw new Error('scan failed');
        return { featureKey: 'feature_name', entries: [{ code: 0, name: 'GeneA' }] };
      }),
    });
    const t = { key: 'transcripts', layerId: 'L', element: el };
    vi.spyOn(console, 'error').mockImplementation(() => {});

    await resolver.ensureFeatureCatalog(t);
    const failed = resolver.snapshot(ctx(el)).resources.catalog;
    expect(Resolution.isFailed(failed as never)).toBe(true);
    if (failed.status === 'failed') expect(failed.error.retryable).toBe(true);
    // The old code marked it permanently complete; here the value is simply not loaded.
    expect(resolver.getFeatureCatalog('transcripts')).toBeUndefined();

    await resolver.retry('transcripts');
    expect(resolver.getFeatureCatalog('transcripts')).toEqual({
      featureKey: 'feature_name',
      entries: [{ code: 0, name: 'GeneA' }],
    });
    expect(Resolution.isReady(resolver.snapshot(ctx(el)).resources.catalog as never)).toBe(true);
  });
});

describe('Track A — cancellation reaches the scan (D8)', () => {
  /** An element whose in-flight scan never settles, capturing the signal it sees. */
  function neverSettlingScanElement() {
    const signals: AbortSignal[] = [];
    const el = {
      key: 'transcripts',
      loadPoints: vi.fn(async () => batch(4)),
      loadPointsMatchingFeatureCodes: vi.fn(
        (opts: { signal?: AbortSignal }) =>
          new Promise<PointsLoadResult>(() => {
            if (opts.signal) signals.push(opts.signal);
          })
      ),
    } as unknown as PointsElement;
    return { el, signals };
  }

  const target = (el: PointsElement) => ({ key: 'transcripts', layerId: 'L', element: el });

  it('supersede aborts the previous scan’s signal — cancellation reaches the element', async () => {
    const resolver = new PointsResolver();
    const { el, signals } = neverSettlingScanElement();
    await resolver.ensureLoaded(target(el));

    resolver.ensureMatchingFeaturesLoaded(target(el), [0]); // scan A
    expect(signals[0]?.aborted).toBe(false);
    resolver.ensureMatchingFeaturesLoaded(target(el), [1]); // scan B supersedes A
    expect(signals[0]?.aborted).toBe(true);
  });

  it('evict aborts an in-flight scan', async () => {
    const resolver = new PointsResolver();
    const { el, signals } = neverSettlingScanElement();
    await resolver.ensureLoaded(target(el));

    resolver.ensureMatchingFeaturesLoaded(target(el), [0]);
    expect(signals[0]?.aborted).toBe(false);
    resolver.evict('transcripts');
    expect(signals[0]?.aborted).toBe(true);
  });
});
