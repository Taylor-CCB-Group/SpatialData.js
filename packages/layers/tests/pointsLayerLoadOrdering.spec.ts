import { describe, expect, it } from 'vitest';
import { PointsLayer } from '../src/PointsLayer.js';
import type { ColumnarNdarrayPointsBatch, PointsLoader } from '../src/pointsLoader.js';

/**
 * `preloadedBatch` is written after an `await`, so whichever read resolves LAST
 * wins regardless of which one is current. Two ways that goes wrong:
 *
 *  1. The streaming overlay bumps `resourceRevision` per chunk, so several reads
 *     of the same loader can be in flight. An earlier, slower one landing last
 *     replaces the grown buffer with a smaller one — points disappear mid-stream.
 *  2. A loader swap (a cap raise) resets the batch state and starts a fresh read,
 *     but a read already in flight against the OLD loader still resolves and
 *     overwrites it. A revision check alone misses this: revisions are per-holder
 *     and can coincide across the swap.
 *
 * (1) is currently masked by the adapter's `loadAll` being await-free, so it
 * resolves in call order — an accident of one implementation, not a guarantee of
 * the `PointsLoader` contract these methods are written against. These drive the
 * reads directly with a controllable `loadAll` so both are pinned regardless.
 */

function batchOf(pointCount: number): ColumnarNdarrayPointsBatch {
  return {
    format: 'columnar-ndarray',
    shape: [2, pointCount],
    data: [new Float32Array(pointCount), new Float32Array(pointCount)],
    pointCount,
  };
}

type Deferred = { promise: Promise<ColumnarNdarrayPointsBatch>; resolve: () => void };

function deferredLoader(batch: ColumnarNdarrayPointsBatch): {
  loader: PointsLoader;
  release: () => void;
} {
  let release = (): void => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const loader = {
    capabilities: { kind: 'preloaded-columnar' },
    loadInBounds: async () => batch,
    loadAll: async () => {
      await gate;
      return batch;
    },
  } as unknown as PointsLoader;
  return { loader, release };
}

/**
 * `PointsLayer` extends deck's `CompositeLayer`, whose `props`/`state` are managed
 * by the layer lifecycle. Drive the private reads against a stand-in with the same
 * two accessors rather than booting a deck instance — the race lives entirely in
 * the await/setState ordering.
 */
function harness(initialLoader: PointsLoader) {
  const layer = Object.create(PointsLayer.prototype) as PointsLayer & {
    ensurePreloadedBatch(): Promise<void>;
    refreshPreloadedBatch(): Promise<void>;
  };
  let state: Record<string, unknown> = { filterGeneration: 0 };
  let props: Record<string, unknown> = {
    resource: { loader: initialLoader },
    resourceRevision: 0,
  };
  Object.defineProperty(layer, 'props', { get: () => props });
  Object.defineProperty(layer, 'state', {
    get: () => state,
    set: (next: Record<string, unknown>) => {
      state = next;
    },
  });
  (layer as unknown as { setState(patch: Record<string, unknown>): void }).setState = (patch) => {
    state = { ...state, ...patch };
  };
  return {
    layer,
    setProps(next: { loader?: PointsLoader; revision?: number }) {
      props = {
        resource: { loader: next.loader ?? (props.resource as { loader: PointsLoader }).loader },
        resourceRevision: next.revision ?? props.resourceRevision,
      };
    },
    preloadedPointCount: () =>
      (state.preloadedBatch as ColumnarNdarrayPointsBatch | undefined)?.pointCount,
  };
}

describe('PointsLayer — out-of-order loadAll resolutions', () => {
  it('does not let a slower earlier revision overwrite a newer batch', async () => {
    const small = deferredLoader(batchOf(10)); // revision 1: 10 points
    const grown = deferredLoader(batchOf(40)); // revision 2: the same buffer, grown

    // One loader identity whose backing buffer grows — model it as two reads by
    // swapping which deferred `loadAll` the props expose, keeping the revision
    // bump as the only signal, exactly as the streaming overlay does.
    const h = harness(small.loader);
    h.setProps({ revision: 1 });
    const first = h.layer.refreshPreloadedBatch();

    h.setProps({ loader: grown.loader, revision: 2 });
    const second = h.layer.refreshPreloadedBatch();

    // The NEWER read completes first, then the older one resolves late.
    grown.release();
    await second;
    expect(h.preloadedPointCount()).toBe(40);

    small.release();
    await first;
    expect(h.preloadedPointCount()).toBe(40); // not clobbered back down to 10
  });

  it('does not let a read against a replaced loader overwrite the new one', async () => {
    // A cap raise swaps the loader; `updateState` resets the batch state and starts
    // a fresh read. The read already in flight against the old loader must not land.
    const oldLoader = deferredLoader(batchOf(10));
    const newLoader = deferredLoader(batchOf(99));

    const h = harness(oldLoader.loader);
    const stale = h.layer.refreshPreloadedBatch();

    // Same revision across the swap — the case a revision-only guard misses.
    h.setProps({ loader: newLoader.loader });
    const fresh = h.layer.ensurePreloadedBatch();

    newLoader.release();
    await fresh;
    expect(h.preloadedPointCount()).toBe(99);

    oldLoader.release();
    await stale;
    expect(h.preloadedPointCount()).toBe(99); // the old loader's batch never lands
  });
});
