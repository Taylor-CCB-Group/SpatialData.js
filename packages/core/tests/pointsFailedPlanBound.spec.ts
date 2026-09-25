import { Matrix4 } from '@math.gl/core';
import { describe, expect, it, vi } from 'vitest';
import {
  type PointsResolveConfig,
  PointsResolver,
  type ResolveContext,
  SpatialEntryStore,
} from '../src/engine/index.js';
import type { PointsElement } from '../src/models/index.js';

/**
 * A resource that FAILS must be planned once, not forever.
 *
 * `plan()` gates every task on "do we have X?", and a failed slot answers no
 * exactly as a slot that never ran does. `SpatialEntryStore.reconcile` keeps no
 * record of settled tasks — only of in-flight ones — so the loop closed: plan
 * emits, the store dispatches, the load fails, the failure notifies, the notify
 * re-commits, plan emits again. On a points element whose parquet layout could not
 * resolve this ran at whatever rate the loader could fail: tens of thousands of
 * requests in ten seconds, still climbing.
 *
 * Counted at the ELEMENT, not in the resolver's internals: the guarantee is about
 * how much work reaches the loader.
 */

const ctx = (
  el: PointsElement,
  config: PointsResolveConfig = {}
): ResolveContext<PointsResolveConfig, PointsElement> => ({
  entryId: 'layer-p',
  elementKey: 'transcripts',
  kind: 'points',
  element: el,
  // Tiling off, as in `pointsResolver.spec.ts`: 'auto' would defer the preload
  // behind a probe and push every assertion here a pass later.
  config: { pointsTiling: 'off', ...config },
  transform: new Matrix4(),
});

/** An element on which every load throws — a parquet layout that will not resolve. */
function brokenElement() {
  const fail = async () => {
    throw new Error('Failed to load parquet footerLength for points/transcripts/points.parquet');
  };
  return {
    key: 'transcripts',
    loadPoints: vi.fn(fail),
    listFeaturesWithCounts: vi.fn(fail),
    loadRowFeatureCodes: vi.fn(fail),
    loadPointsMatchingFeatureCodes: vi.fn(fail),
  } as unknown as PointsElement;
}

/** Reconcile repeatedly, the way a re-render does. */
async function settle(store: SpatialEntryStore, context: ResolveContext, passes: number) {
  for (let i = 0; i < passes; i += 1) {
    await store.reconcile([context]);
  }
}

describe('PointsResolver — a failed resource is not re-planned', () => {
  it('stops planning a preload once it has failed at this cap', async () => {
    const resolver = new PointsResolver();
    const store = new SpatialEntryStore({ points: resolver });
    const el = brokenElement();
    const context = ctx(el);

    await settle(store, context, 20);

    // One attempt, not twenty. The number that matters is "bounded", and the bound
    // the design gives is one-per-key.
    expect(el.loadPoints).toHaveBeenCalledTimes(1);
    expect(resolver.plan(context).map((t) => t.resource)).not.toContain('preload');
  });

  it('stops planning rowCodes once they have failed', async () => {
    const resolver = new PointsResolver();
    const store = new SpatialEntryStore({ points: resolver });
    const el = brokenElement();
    const context = ctx(el);

    await settle(store, context, 20);

    expect(el.loadRowFeatureCodes).toHaveBeenCalledTimes(1);
    expect(resolver.plan(context).map((t) => t.resource)).not.toContain('rowCodes');
  });

  it('retry() is the way back — and is itself bounded', async () => {
    const resolver = new PointsResolver();
    const store = new SpatialEntryStore({ points: resolver });
    const el = brokenElement();
    const context = ctx(el);

    await settle(store, context, 5);
    const afterFirstFailure = vi.mocked(el.loadPoints).mock.calls.length;

    await resolver.retry('transcripts');
    await settle(store, context, 5);

    // Exactly one more attempt: the retry, and nothing the reconciles added.
    expect(el.loadPoints).toHaveBeenCalledTimes(afterFirstFailure + 1);
  });

  it('a cap change is a different request and still dispatches', async () => {
    const resolver = new PointsResolver();
    const store = new SpatialEntryStore({ points: resolver });
    const el = brokenElement();

    await settle(store, ctx(el, { pointsMemoryCap: 4_000_000 }), 5);
    const afterSmallCap = vi.mocked(el.loadPoints).mock.calls.length;

    await settle(store, ctx(el, { pointsMemoryCap: 8_000_000 }), 5);

    // The failure is remembered per KEY, not per slot: raising the cap asks a
    // genuinely different question and must not inherit the old refusal.
    expect(vi.mocked(el.loadPoints).mock.calls.length).toBe(afterSmallCap + 1);
  });

  it('bounds the whole entry, not just one resource', async () => {
    const resolver = new PointsResolver();
    const store = new SpatialEntryStore({ points: resolver });
    const el = brokenElement();
    const context = ctx(el, { featureCodes: [0, 1] });

    await settle(store, context, 30);

    const total =
      vi.mocked(el.loadPoints).mock.calls.length +
      vi.mocked(el.loadRowFeatureCodes).mock.calls.length +
      vi.mocked(el.loadPointsMatchingFeatureCodes).mock.calls.length +
      vi.mocked(el.listFeaturesWithCounts).mock.calls.length;

    // Generous, and still orders of magnitude below an unbounded loop: thirty
    // reconciles of a comprehensively broken element cost a handful of attempts.
    expect(total).toBeLessThan(10);
    expect(resolver.plan(context)).toHaveLength(0);
  });
});
