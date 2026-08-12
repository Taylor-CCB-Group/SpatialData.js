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
import { MORTON_CODE_2D_COLUMN, type PointsTilingMetadata } from '../src/pointsTiling.js';

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

  it('plans a preload for a fresh entry, plus rowCodes (colour is on by default)', () => {
    const tasks = new PointsResolver().plan(ctx(element()));

    // Colour-by-feature is on by default, so the per-row codes are planned alongside
    // the preload — for a code-column dataset they fall out of the preload decode (the
    // rowCodes task is then a no-op); for a dict-only dataset the task settles them.
    expect(tasks.map((t) => t.resource)).toEqual(['preload', 'rowCodes']);
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

  it('plans rowCodes by default (colour is on by default), skipping only when colour is off and nothing is selected', () => {
    const resolver = new PointsResolver();
    const resources = (config: PointsResolveConfig) =>
      resolver.plan(ctx(element(), config)).map((t) => t.resource);

    // Colour-by-feature is on by default, so the codes load without any explicit flag.
    expect(resources({})).toContain('rowCodes');
    expect(resources({ colorByFeature: true })).toContain('rowCodes');
    expect(resources({ featureCodes: [0] })).toContain('rowCodes');
    // A live filter still needs the codes even with colour explicitly off.
    expect(resources({ featureCodes: [0], colorByFeature: false })).toContain('rowCodes');
    // Colour explicitly off AND nothing selected: no code consumer, so skip the load.
    expect(resources({ colorByFeature: false })).not.toContain('rowCodes');
    // An empty selection is "no filter", not "filter to nothing".
    expect(resources({ featureCodes: [], colorByFeature: false })).not.toContain('rowCodes');
  });

  it('plans a matching scan only once the element is known to support one', async () => {
    const resolver = new PointsResolver();
    // Truncated: rows exist beyond what is resident, so a scan can actually add
    // something. (A complete batch is covered by the next test.)
    const el = element({
      loadPoints: vi.fn(async () => batch(4, { preloadTruncated: true, totalRowCount: 1_000 })),
    });
    const config: PointsResolveConfig = { featureCodes: [0] };

    // Before anything loads we cannot know whether a scan is even possible.
    expect(resolver.plan(ctx(el, config)).map((t) => t.resource)).not.toContain('matching');

    await resolver.ensureLoaded({ key: 'transcripts', layerId: 'layer-p', element: el });

    expect(resolver.plan(ctx(el, config)).map((t) => t.resource)).toContain('matching');
  });

  it('plans no matching scan when the resident batch holds every row', async () => {
    // A complete preload already contains every matching row, so the render path's
    // in-memory filter is exact and a whole-dataset scan is pure waste. Scanning
    // anyway made a selection on a fully-resident element sit on "Loading selected
    // features… 0 points so far" while it re-read the entire file.
    const resolver = new PointsResolver();
    const el = element(); // batch(4), untruncated
    const config: PointsResolveConfig = { featureCodes: [0] };

    await resolver.ensureLoaded({ key: 'transcripts', layerId: 'layer-p', element: el });

    expect(resolver.plan(ctx(el, config)).map((t) => t.resource)).not.toContain('matching');
    expect(el.loadPointsMatchingFeatureCodes).not.toHaveBeenCalled();
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
    // geometry gates a first paint — and blockingResources says so as DATA, which is
    // what today's isBlocking kind-switch collapses into. `tiling` is here because
    // until the probe answers we do not know which geometry path this entry is on;
    // an entry whose snapshot omits either resource simply does not block on it.
    const resolver = new PointsResolver();

    expect(resolver.blockingResources).toEqual(['tiling', 'preload']);
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

describe('progressive preload (D3)', () => {
  // The fix for "a cold wild-type transcripts load shows nothing for ages": the
  // preload publishes its growing geometry so the base can paint while the rest
  // decodes, instead of only after the whole capped window lands.
  it('exposes the growing geometry as a preload partial, then settles the full batch', async () => {
    // An element whose loadPoints streams two chunks before resolving.
    const el = element({
      loadPoints: vi.fn(
        async (options: {
          onProgress?: (p: {
            scannedRows: number;
            matchedRows: number;
            partIndex: number;
            partCount: number;
            partialResult: PointsLoadResult;
          }) => void;
        }) => {
          options.onProgress?.({
            scannedRows: 2,
            matchedRows: 2,
            partIndex: 0,
            partCount: 2,
            partialResult: batch(2),
          });
          options.onProgress?.({
            scannedRows: 4,
            matchedRows: 4,
            partIndex: 1,
            partCount: 2,
            partialResult: batch(4),
          });
          return batch(4);
        }
      ),
    });
    const resolver = new PointsResolver();
    const seen: number[] = [];
    resolver.subscribe(() => {
      const partial = resolver.getPreloadPartialBatch('transcripts');
      if (partial) seen.push(partial.shape[1] ?? 0);
    });

    const pending = resolver.ensureLoaded({ key: 'transcripts', layerId: 'l', element: el });
    // Partials are published while the load is still in flight — that IS the feature.
    expect(resolver.getPreloadPartialBatch('transcripts')?.shape[1]).toBe(4);
    await pending;

    // Once settled, the resident batch takes over and equals the one-shot result.
    expect(resolver.getData('transcripts')?.shape[1]).toBe(4);
    // At least one growing partial was observed before the settle.
    expect(seen.length).toBeGreaterThan(0);
  });

  it('passes an onProgress through to the element so streaming can happen at all', async () => {
    const el = element();
    const resolver = new PointsResolver();
    await resolver.ensureLoaded({ key: 'transcripts', layerId: 'l', element: el });

    expect(el.loadPoints).toHaveBeenCalledWith(
      expect.objectContaining({ onProgress: expect.any(Function) })
    );
  });
});

describe('getMatchingLoadState() — a failed scan is reportable', () => {
  // The gap this closes: a failed scan used to be indistinguishable from "no scan
  // has run" (both `undefined`), while the render path kept drawing the resident
  // subset. The panel therefore presented a partial view as the complete answer,
  // with no error anywhere. See #149.
  const failing = (message = 'scan exploded') =>
    element({
      loadPointsMatchingFeatureCodes: vi.fn(async () => {
        throw new Error(message);
      }),
    });

  it('reports the failure, its message, and no rows', async () => {
    const resolver = new PointsResolver();
    const el = failing();

    await resolver.ensureMatchingFeaturesLoaded(
      { key: 'transcripts', layerId: 'l', element: el },
      [1]
    );

    const state = resolver.getMatchingLoadState('transcripts', [1]);
    expect(state?.failed).toBe(true);
    expect(state?.settled).toBe(true);
    expect(state?.loading).toBe(false);
    // Not the stale batch's row count — nothing landed for THIS selection.
    expect(state?.matchedRows).toBe(0);
    expect(state?.error?.message).toContain('scan exploded');
  });

  it('reports the failure for a subset of the selection that failed', async () => {
    const resolver = new PointsResolver();

    await resolver.ensureMatchingFeaturesLoaded(
      { key: 'transcripts', layerId: 'l', element: failing() },
      [1, 2]
    );

    // A scan for {1,2} was going to supply {1}, so shrinking the selection does not
    // make the failure irrelevant — those points are still not loaded.
    expect(resolver.getMatchingLoadState('transcripts', [1])?.failed).toBe(true);
  });

  it('does not report a failure against an unrelated selection', async () => {
    const resolver = new PointsResolver();

    await resolver.ensureMatchingFeaturesLoaded(
      { key: 'transcripts', layerId: 'l', element: failing() },
      [1]
    );

    // {7} was never part of the failed scan; claiming it failed would be as wrong as
    // staying silent about {1}.
    expect(resolver.getMatchingLoadState('transcripts', [7])).toBeUndefined();
  });

  it('does not let a stale good batch mask the failure', async () => {
    const resolver = new PointsResolver();
    const target = { key: 'transcripts', layerId: 'l', element: element() };

    // A good scan for {1} first, so the slot retains it as `stale`...
    await resolver.ensureMatchingFeaturesLoaded(target, [1]);
    expect(resolver.getMatchingLoadState('transcripts', [1])?.failed).toBeUndefined();

    // ...then a failing scan for {2}. Reading `lastGood` first would answer with the
    // {1} batch and call {2} settled.
    await resolver.ensureMatchingFeaturesLoaded(
      { key: 'transcripts', layerId: 'l', element: failing() },
      [2]
    );
    expect(resolver.getMatchingLoadState('transcripts', [2])?.failed).toBe(true);
  });

  it('clears the failure when a retry succeeds', async () => {
    const resolver = new PointsResolver();
    let shouldFail = true;
    const el = element({
      loadPointsMatchingFeatureCodes: vi.fn(async () => {
        if (shouldFail) throw new Error('transient');
        return batch(2);
      }),
    });

    await resolver.ensureMatchingFeaturesLoaded(
      { key: 'transcripts', layerId: 'l', element: el },
      [1]
    );
    expect(resolver.getMatchingLoadState('transcripts', [1])?.failed).toBe(true);
    expect(resolver.getMatchingLoadState('transcripts', [1])?.error?.retryable).toBe(true);

    shouldFail = false;
    await resolver.retry('transcripts');

    const state = resolver.getMatchingLoadState('transcripts', [1]);
    expect(state?.failed).toBeUndefined();
    expect(state?.matchedRows).toBe(2);
  });
});

describe('D5 step 1 — Morton tiling metadata probe', () => {
  /** Renderable Morton metadata: range reads AND bounds, the two things the tile
   * path cannot work without. */
  const tiling = (over: Partial<PointsTilingMetadata> = {}): PointsTilingMetadata => ({
    kind: 'morton-points',
    parquetPath: 'points/transcripts/points.parquet',
    axisNames: ['x', 'y'],
    featureCodeColumnName: 'feature_name_codes',
    mortonCodeColumnName: MORTON_CODE_2D_COLUMN,
    totalRows: 12_000_000,
    totalRowGroups: 96,
    maxRowsPerGroup: 131_072,
    supportsRowGroupRangeReads: true,
    bounds: { minX: 0, minY: 0, maxX: 100, maxY: 100 },
    ...over,
  });

  const tiledElement = (metadata: PointsTilingMetadata | null, over = {}) =>
    element({ getPointsTilingMetadata: vi.fn(async () => metadata), ...over });

  const store = (resolver: PointsResolver) =>
    new SpatialEntryStore({
      points: resolver,
      shapes: resolver,
      images: resolver,
      labels: resolver,
    });

  // The step-1 acceptance criterion, as a test: with tiling off — the default —
  // nothing about planning changes. Everything else in this file is the regression
  // net for that claim; this is the direct statement of it.
  it('is off by default: no probe, and the preload is planned exactly as before', () => {
    const el = tiledElement(tiling());
    const tasks = new PointsResolver().plan(ctx(el));

    expect(tasks.map((t) => t.resource)).toEqual(['preload', 'rowCodes']);
    expect(el.getPointsTilingMetadata).not.toHaveBeenCalled();
  });

  it('plans a probe — and DEFERS the preload — when tiling is auto', () => {
    const el = tiledElement(tiling());
    const tasks = new PointsResolver().plan(ctx(el, { pointsTiling: 'auto' }));

    // Preloading a table we are about to tile wastes the entire read, so until the
    // probe answers we schedule neither.
    expect(tasks.map((t) => t.resource)).toEqual(['tiling']);
    // …and planning still starts nothing.
    expect(el.getPointsTilingMetadata).not.toHaveBeenCalled();
  });

  it('settles the metadata for a tileable element, and then plans no preload at all', async () => {
    const resolver = new PointsResolver();
    const el = tiledElement(tiling());

    await resolver.ensureTilingMetadata({ key: 'transcripts', layerId: 'L', element: el });

    expect(resolver.isTiled('transcripts')).toBe(true);
    expect(resolver.getTilingMetadata('transcripts')?.totalRowGroups).toBe(96);
    // Row codes and the matching scan are resident-batch notions; a tiled element has
    // no resident batch, so neither is planned (per-tile codes are step 4).
    expect(resolver.plan(ctx(el, { pointsTiling: 'auto', featureCodes: [0, 1] }))).toEqual([]);
  });

  it('settles null when the artifact cannot drive tiles, and falls back to the preload', async () => {
    const resolver = new PointsResolver();
    // Morton metadata exists but the store cannot serve row-group range reads — the
    // same renderability gate the render resolver applies, made once, here.
    const el = tiledElement(tiling({ supportsRowGroupRangeReads: false }));
    const config = { pointsTiling: 'auto' as const };

    await store(resolver).reconcile([ctx(el, config)]);

    expect(resolver.getTilingMetadata('transcripts')).toBeNull();
    expect(resolver.isTiled('transcripts')).toBe(false);
    expect(resolver.plan(ctx(el, config)).map((t) => t.resource)).toEqual(['preload', 'rowCodes']);
  });

  it('settles null when the element has no Morton artifact', async () => {
    const resolver = new PointsResolver();
    const el = tiledElement(null);

    await resolver.ensureTilingMetadata({ key: 'transcripts', layerId: 'L', element: el });

    expect(resolver.getTilingMetadata('transcripts')).toBeNull();
  });

  it('a failed probe falls through to the preload instead of stranding the layer', async () => {
    const resolver = new PointsResolver();
    const el = tiledElement(null, {
      getPointsTilingMetadata: vi.fn(async () => {
        throw new Error('footer read failed');
      }),
    });
    const config = { pointsTiling: 'auto' as const };

    await resolver.ensureTilingMetadata({ key: 'transcripts', layerId: 'L', element: el });

    // The failure is a state — visible, and retryable…
    const failed = resolver.snapshot(ctx(el, config)).resources.tiling;
    expect(Resolution.isFailed(failed as never)).toBe(true);
    if (failed.status === 'failed') expect(failed.error.retryable).toBe(true);
    // …but it must not stop anything drawing: it reads as "cannot tile", so the next
    // plan pass schedules the ordinary preload.
    expect(resolver.getTilingMetadata('transcripts')).toBeNull();
    expect(resolver.plan(ctx(el, config)).map((t) => t.resource)).toEqual(['preload', 'rowCodes']);
  });

  it('does not re-probe a failed element on every reconcile', async () => {
    const resolver = new PointsResolver();
    const el = tiledElement(null, {
      getPointsTilingMetadata: vi.fn(async () => {
        throw new Error('footer read failed');
      }),
    });
    const s = store(resolver);
    const config = { pointsTiling: 'auto' as const };

    await s.reconcile([ctx(el, config)]);
    await s.reconcile([ctx(el, config)]);

    // A failure that re-planned itself would spin forever AND keep the preload it is
    // standing in front of permanently unscheduled.
    expect(el.getPointsTilingMetadata).toHaveBeenCalledTimes(1);
  });

  it('retry() re-runs a failed probe', async () => {
    const resolver = new PointsResolver();
    let attempts = 0;
    const el = tiledElement(null, {
      getPointsTilingMetadata: vi.fn(async () => {
        attempts += 1;
        if (attempts === 1) throw new Error('footer read failed');
        return tiling();
      }),
    });

    await resolver.ensureTilingMetadata({ key: 'transcripts', layerId: 'L', element: el });
    expect(resolver.isTiled('transcripts')).toBe(false);

    await resolver.retry('transcripts');

    expect(resolver.isTiled('transcripts')).toBe(true);
  });

  it('dedups the probe: one request per element, however many reconciles', async () => {
    const resolver = new PointsResolver();
    const el = tiledElement(tiling());
    const s = store(resolver);
    const config = { pointsTiling: 'auto' as const };

    await Promise.all([s.reconcile([ctx(el, config)]), s.reconcile([ctx(el, config)])]);
    await s.reconcile([ctx(el, config)]);

    expect(el.getPointsTilingMetadata).toHaveBeenCalledTimes(1);
  });

  // The deferral only works because a settle notifies, the host replans, and the
  // preload is scheduled on that second pass. Without it a non-tileable element would
  // sit forever behind a probe that already answered.
  it('schedules the deferred preload on the reconcile after the probe answers', async () => {
    const resolver = new PointsResolver();
    const el = tiledElement(null);
    const s = store(resolver);
    const config = { pointsTiling: 'auto' as const };

    await s.reconcile([ctx(el, config)]);
    expect(el.loadPoints).not.toHaveBeenCalled();

    await s.reconcile([ctx(el, config)]);
    expect(el.loadPoints).toHaveBeenCalledTimes(1);
  });

  it('a tileable element never preloads, however many reconciles run', async () => {
    const resolver = new PointsResolver();
    const el = tiledElement(tiling());
    const s = store(resolver);
    const config = { pointsTiling: 'auto' as const };

    await s.reconcile([ctx(el, config)]);
    await s.reconcile([ctx(el, config)]);

    expect(el.loadPoints).not.toHaveBeenCalled();
  });

  it('evict drops the probe answer with the rest of the entry', async () => {
    const resolver = new PointsResolver();
    const el = tiledElement(tiling());

    await resolver.ensureTilingMetadata({ key: 'transcripts', layerId: 'L', element: el });
    resolver.evict('transcripts');

    expect(resolver.getTilingMetadata('transcripts')).toBeUndefined();
    expect(resolver.isTilingSettled('transcripts')).toBe(false);
  });
});

describe('D5 step 2 — a tiled entry is drawable, framed and unblocked', () => {
  const tiling = (over: Partial<PointsTilingMetadata> = {}): PointsTilingMetadata => ({
    kind: 'morton-points',
    parquetPath: 'points/transcripts/points.parquet',
    axisNames: ['x', 'y'],
    featureCodeColumnName: 'feature_name_codes',
    mortonCodeColumnName: MORTON_CODE_2D_COLUMN,
    totalRows: 12_000_000,
    totalRowGroups: 96,
    maxRowsPerGroup: 131_072,
    supportsRowGroupRangeReads: true,
    bounds: { minX: 10, minY: 20, maxX: 110, maxY: 220 },
    ...over,
  });

  const tiledElement = (metadata: PointsTilingMetadata | null) =>
    element({ getPointsTilingMetadata: vi.fn(async () => metadata) });

  const store = (resolver: PointsResolver) =>
    new SpatialEntryStore({
      points: resolver,
      shapes: resolver,
      images: resolver,
      labels: resolver,
    });

  const auto = { pointsTiling: 'auto' as const };

  // THE step-2 bug this guards. A tiled entry plans no preload, so a `preload`
  // resolution left sitting at `idle` reads as blocking forever — and auto-fit rides
  // the isBlocking true→false transition, so the layer never frames either.
  it('stops blocking once the probe answers, without ever preloading', async () => {
    const resolver = new PointsResolver();
    const el = tiledElement(tiling());
    const s = store(resolver);

    // Blocked while the probe is open: we cannot draw what we cannot classify.
    expect(s.isBlocking(ctx(el, auto))).toBe(true);

    await s.reconcile([ctx(el, auto)]);

    expect(s.isBlocking(ctx(el, auto))).toBe(false);
    expect(el.loadPoints).not.toHaveBeenCalled();
  });

  it('still blocks a non-tileable entry until its preload lands', async () => {
    const resolver = new PointsResolver();
    const el = tiledElement(null);
    const s = store(resolver);

    await s.reconcile([ctx(el, auto)]); // probe settles null…
    expect(s.isBlocking(ctx(el, auto))).toBe(true); // …and there is still nothing to draw

    await s.reconcile([ctx(el, auto)]); // …so the preload runs

    expect(s.isBlocking(ctx(el, auto))).toBe(false);
  });

  it('reports only the resources the entry actually has', async () => {
    const resolver = new PointsResolver();
    const el = tiledElement(tiling());

    // Tiling off: the entry never asked the question, so it has no tiling resource.
    expect(Object.keys(resolver.snapshot(ctx(el)).resources)).not.toContain('tiling');

    await store(resolver).reconcile([ctx(el, auto)]);

    // Tiled: no resident preload exists — absent, not idle. `isBlocking` skips a
    // resource that is not there, which is what the test above depends on.
    const resources = resolver.snapshot(ctx(el, auto)).resources;
    expect(Object.keys(resources)).toContain('tiling');
    expect(Object.keys(resources)).not.toContain('preload');
  });

  it('frames from the artifact extent, through the element transform', async () => {
    const resolver = new PointsResolver();
    const el = tiledElement(tiling());
    await store(resolver).reconcile([ctx(el, auto)]);

    const shifted = {
      ...ctx(el, auto),
      transform: new Matrix4().translate([5, 7, 0]),
    };
    expect(resolver.snapshot(shifted).bounds).toEqual({
      minX: 15,
      minY: 27,
      maxX: 115,
      maxY: 227,
    });
  });

  it('returns identity-stable bounds — a fresh object per call is a deck teardown', async () => {
    const resolver = new PointsResolver();
    const el = tiledElement(tiling());
    await store(resolver).reconcile([ctx(el, auto)]);

    const base = ctx(el, auto);
    const first = resolver.snapshot(base).bounds;
    // A DIFFERENT snapshot object (another entry on the same element, so the snapshot
    // memo misses) must still hand back the same bounds object: the memo below it
    // keys on (metadata, transform), and both entries share the element's transform.
    const again = resolver.snapshot({ ...base, entryId: 'other-layer' }).bounds;

    expect(first).not.toBeNull();
    expect(again).toBe(first);
  });

  it('reports geometry status for the tiled path, not silence', async () => {
    const resolver = new PointsResolver();
    const statuses: Array<[string, string]> = [];
    const withStatus = new PointsResolver({
      onStatus: (layerId, status) => statuses.push([layerId, status]),
    });
    const el = tiledElement(tiling());
    void resolver;

    const pending = withStatus.ensureTilingMetadata({
      key: 'transcripts',
      layerId: 'layer-p',
      element: el,
    });
    // Mid-probe the entry IS loading its geometry; reporting 'idle' would leave the
    // host showing nothing-is-happening for the whole footer read.
    expect(withStatus.getStatus('transcripts')).toBe('loading');
    await pending;

    // A tileable answer is terminal: there is no preload to wait for.
    expect(withStatus.getStatus('transcripts')).toBe('ready');
    expect(statuses).toEqual([
      ['layer-p', 'loading'],
      ['layer-p', 'ready'],
    ]);
  });

  it('does not claim ready when the probe hands off to the preload', async () => {
    const statuses: string[] = [];
    const resolver = new PointsResolver({
      onStatus: (_layerId, status) => statuses.push(status),
    });
    const el = tiledElement(null);

    await resolver.ensureTilingMetadata({ key: 'transcripts', layerId: 'L', element: el });

    // 'ready' here would clear the spinner while the real geometry load had not even
    // been planned yet.
    expect(statuses).toEqual(['loading']);
    expect(resolver.getStatus('transcripts')).toBe('idle');
  });
});

describe('D5 — tiling is per entry, the probe answer is per element', () => {
  const tiling = (): PointsTilingMetadata => ({
    kind: 'morton-points',
    parquetPath: 'points/transcripts/points.parquet',
    axisNames: ['x', 'y'],
    featureCodeColumnName: 'feature_name_codes',
    mortonCodeColumnName: MORTON_CODE_2D_COLUMN,
    totalRows: 12_000_000,
    totalRowGroups: 96,
    maxRowsPerGroup: 131_072,
    supportsRowGroupRangeReads: true,
    bounds: { minX: 0, minY: 0, maxX: 100, maxY: 100 },
  });

  const tiledElement = () => element({ getPointsTilingMetadata: vi.fn(async () => tiling()) });

  /**
   * Found in the browser, not by a test: switch tiling ON, then OFF, and the layer
   * kept drawing tiles. The probe's answer is cached per ELEMENT and survives the
   * config that asked for it, so anything keyed on `isTiled` alone ignores the switch.
   * `plan()` meanwhile went back to preloading — so the app both preloaded AND drew
   * tiles.
   */
  it('goes back to the preloaded path when tiling is switched off', async () => {
    const resolver = new PointsResolver();
    const el = tiledElement();
    const on = ctx(el, { pointsTiling: 'auto' });
    const off = ctx(el, { pointsTiling: 'off' });

    await resolver.ensureTilingMetadata({ key: 'transcripts', layerId: 'layer-p', element: el });

    // The element fact does not change — the metadata is still cached and valid…
    expect(resolver.isTiled('transcripts')).toBe(true);
    // …but this entry no longer asked for it, so it plans a preload again…
    expect(resolver.plan(off).map((t) => t.resource)).toEqual(['preload', 'rowCodes']);
    expect(resolver.plan(on)).toEqual([]);
    // …and its snapshot reports a preload resource (which gates first paint) and no
    // tiling-derived bounds.
    expect(Object.keys(resolver.snapshot(off).resources)).toContain('preload');
    expect(resolver.snapshot(off).bounds).toBeNull();
    expect(resolver.snapshot(on).bounds).not.toBeNull();
  });

  it('lets two entries on one element disagree', async () => {
    const resolver = new PointsResolver();
    const el = tiledElement();
    const tiledEntry = { ...ctx(el, { pointsTiling: 'auto' }), entryId: 'tiled' };
    const preloadEntry = { ...ctx(el, { pointsTiling: 'off' }), entryId: 'preloaded' };

    await resolver.ensureTilingMetadata({ key: 'transcripts', layerId: 'tiled', element: el });

    expect(resolver.snapshot(tiledEntry).resources.preload).toBeUndefined();
    expect(resolver.snapshot(preloadEntry).resources.preload).toBeDefined();
  });

  it('reports the preload status even for an element something else tiles', async () => {
    // getStatus is per element; the preload is the load actually in flight for the
    // entry that is not tiling, so it must not be masked by the probe's answer.
    const resolver = new PointsResolver();
    const el = tiledElement();

    await resolver.ensureTilingMetadata({ key: 'transcripts', layerId: 'tiled', element: el });
    expect(resolver.getStatus('transcripts')).toBe('ready');

    await resolver.ensureLoaded({ key: 'transcripts', layerId: 'preloaded', element: el });
    expect(resolver.getStatus('transcripts')).toBe('ready');
    expect(el.loadPoints).toHaveBeenCalledTimes(1);
  });
});
