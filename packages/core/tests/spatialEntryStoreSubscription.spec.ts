import { describe, expect, it, vi } from 'vitest';
import {
  type EntryResources,
  Resolution,
  type ResolveTask,
  SpatialEntryStore,
} from '../src/engine/index.js';

/**
 * The store's bridge to its resolvers, under the lifecycle React actually gives it.
 *
 * `SpatialEntryStore` is memoised by `useLayerData` and disposed from an effect
 * cleanup — and an effect cleanup is not "the end". StrictMode's dev double-mount
 * runs cleanup and then re-runs the effect against the same store instance. When the
 * bridge was built in the constructor and torn down in `dispose`, that sequence left
 * the store permanently deaf: resolvers went on loading and settling, and nothing
 * downstream ever heard about it. The symptom was a fill-colour column that loaded
 * and then never painted until an unrelated re-render came along.
 *
 * These tests drive that sequence directly, with a resolver stub whose only job is to
 * emit one settle.
 */

/** A resolver that does nothing but let a test fire its settle notification. */
function notifyingResolver() {
  const listeners = new Set<() => void>();
  return {
    resolver: {
      kind: 'labels' as const,
      blockingResources: [] as const,
      plan: (): readonly ResolveTask[] => [],
      load: async () => {},
      snapshot: (): EntryResources => ({
        entryId: 'e',
        elementKey: 'k',
        resources: {},
        notices: [],
        bounds: null,
        revision: 0,
      }),
      evict: () => {},
      dispose: () => {
        listeners.clear();
      },
      subscribe: (listener: () => void) => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
      getVersion: () => 0,
    },
    /** Stand in for a load settling — what `finally { this.notify() }` does. */
    settle: () => {
      for (const listener of listeners) listener();
    },
    listenerCount: () => listeners.size,
  };
}

function storeWith(labels: ReturnType<typeof notifyingResolver>['resolver']) {
  const inert = { ...labels, subscribe: () => () => {} };
  return new SpatialEntryStore({
    points: inert,
    shapes: inert,
    images: inert,
    labels,
  });
}

describe('SpatialEntryStore — the resolver notification bridge', () => {
  it('forwards a resolver settle to its listeners', () => {
    const labels = notifyingResolver();
    const store = storeWith(labels.resolver);
    const onChange = vi.fn();
    store.subscribe(onChange);

    labels.settle();

    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('still forwards a settle after dispose + resubscribe (the StrictMode remount)', () => {
    // THE regression. React runs cleanup then re-runs the effect against the same
    // memoised store; nothing about that says the store is finished.
    const labels = notifyingResolver();
    const store = storeWith(labels.resolver);
    const onChange = vi.fn();

    const unsubscribe = store.subscribe(onChange);
    unsubscribe();
    store.dispose();
    store.subscribe(onChange);

    labels.settle();

    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('holds no resolver subscription while nobody is listening', () => {
    // The bridge exists for listeners. With none, it must not pin the resolver —
    // otherwise a discarded store keeps a live edge into a resolver it no longer owns.
    const labels = notifyingResolver();
    const store = storeWith(labels.resolver);

    expect(labels.listenerCount()).toBe(0);

    const unsubscribe = store.subscribe(vi.fn());
    expect(labels.listenerCount()).toBe(1);

    unsubscribe();
    expect(labels.listenerCount()).toBe(0);
  });

  it('attaches once for many listeners, and detaches only when the last one goes', () => {
    const labels = notifyingResolver();
    const store = storeWith(labels.resolver);
    const first = vi.fn();
    const second = vi.fn();

    const unsubscribeFirst = store.subscribe(first);
    const unsubscribeSecond = store.subscribe(second);
    expect(labels.listenerCount()).toBe(1);

    unsubscribeFirst();
    expect(labels.listenerCount()).toBe(1);

    labels.settle();
    expect(second).toHaveBeenCalledTimes(1);

    unsubscribeSecond();
    expect(labels.listenerCount()).toBe(0);
  });
});
