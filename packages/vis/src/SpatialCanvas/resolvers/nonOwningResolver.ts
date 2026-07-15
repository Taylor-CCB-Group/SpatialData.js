import type { PointsElement, PointsResolveConfig, ResourceResolver } from '@spatialdata/core';

/**
 * Wrap a resolver so a {@link import('@spatialdata/core').SpatialEntryStore} can
 * drive it WITHOUT owning its lifecycle: every method delegates to `inner`, but
 * `dispose()` is a no-op.
 *
 * This deliberately goes against the grain of the store's ownership model, so it is
 * worth being explicit about why.
 *
 * ## The problem: two owners for one resolver
 *
 * `SpatialEntryStore` is designed to OWN the resolvers it holds — it subscribes to
 * each in its constructor and disposes each in `dispose()`. That model fits the
 * `useLayerData` shapes/images/labels resolvers exactly: they close over
 * `spatialData`, so a dataset swap rebuilds them (their `useMemo`s are keyed on
 * `spatialData`), which rebuilds the store, whose cleanup disposes the now-replaced
 * instances. One owner, clean handoff.
 *
 * Points does not fit that model. Its resolver lives inside `PointsDataEngine`, a
 * value the hook holds in `useState` and creates exactly ONCE — because the feature
 * panels subscribe to the engine directly (via `PointsFeatureStateProvider`) and the
 * identity-stable render-resource memos live in the engine's adapter. The engine has
 * to persist across dataset swaps, or those subscriptions break and the resident
 * points cache is thrown away on every swap. So points has a *pre-existing,
 * independent owner* that the store did not create and must not end.
 *
 * Hand the engine's real resolver straight to the store and the two owners collide:
 * the first dataset swap rebuilds the store, and the old store's cleanup calls
 * `dispose()` on every resolver it holds — including the points one — clearing the
 * engine's entries, snapshots and listeners while the engine itself lives on. Panels
 * go dead; the cache is gone. This proxy severs exactly that one edge: the store may
 * subscribe, plan, load, snapshot and evict through it, but it may not dispose it.
 * `PointsDataEngine.dispose()` stays the sole disposer.
 *
 * ## Why the no-op is correct, not merely safe
 *
 * `SpatialEntryStore.dispose()` also aborts a resolver's in-flight tasks. We do not
 * want that reaching points either: an in-flight preload belongs to the surviving
 * engine, not to the store being torn down. (In Step 1 it is moot — every resolver
 * ignores the load `signal` and dedups on its own in-flight map — but the intent is
 * that store teardown must not touch the engine at all.)
 *
 * ## Why this does NOT reintroduce "points is special" inside the store
 *
 * The store still holds four opaque `ResourceResolver`s and cannot tell which one is
 * proxied — the whole point of its kind-blindness (see its class doc). The asymmetry
 * lives entirely in the host's construction, which is the correct home for a
 * host-specific lifecycle quirk: the store's interface stays honest.
 *
 * ## Alternatives considered and rejected
 *
 * - Rebuild `PointsDataEngine` on `spatialData` like the others — uniform lifecycle,
 *   but loses the cache and breaks panel subscriptions on every swap. That is the
 *   exact thing the stable engine exists to prevent.
 * - Make shapes/images/labels stable like points — they read `spatialData` in
 *   `load()` (tooltip / associated-table / multiscales), captured at construction, so
 *   a stable instance would silently use the previous dataset after a swap.
 * - Keep points out of the store, driven by its own effect — no proxy, but then there
 *   are two driving mechanisms again, which is precisely what the reconcile loop
 *   collapses into one.
 *
 * ## Exit condition (when this can be deleted)
 *
 * The proxy becomes unnecessary the day points shares the others' lifecycle — most
 * cleanly if `spatialData` were threaded through `ResolveContext` so that NO resolver
 * closes over it and none needs rebuilding (then all four could be stable and the
 * store could own them uniformly), or if the engine's stable-handle duties moved onto
 * the store itself. Both are larger than Step 1; until then, a no-op `dispose` on one
 * edge is the smallest cut that keeps the store honest and the engine intact.
 */
export function createNonOwningResolver(
  inner: ResourceResolver<PointsResolveConfig, PointsElement>
): ResourceResolver<PointsResolveConfig, PointsElement> {
  return {
    kind: inner.kind,
    blockingResources: inner.blockingResources,
    plan: (ctx) => inner.plan(ctx),
    load: (task, ctx, signal) => inner.load(task, ctx, signal),
    snapshot: (ctx) => inner.snapshot(ctx),
    subscribe: (listener) => inner.subscribe(listener),
    getVersion: () => inner.getVersion(),
    evict: (key) => inner.evict(key),
    // The one edge we cut — see the doc above. Everything else delegates.
    dispose: () => {},
  };
}
