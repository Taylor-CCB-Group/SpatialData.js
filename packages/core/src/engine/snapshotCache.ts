import type { EntryResources } from './resolver.js';

/**
 * Per-entry memoisation for `snapshot()`, keyed by everything a snapshot can
 * actually depend on.
 *
 * ## Why keying on the resolver version alone is wrong
 *
 * An `EntryResources` embeds three things that vary *per call*, not per resolver
 * mutation:
 *
 *  - `entryId` — several entries (layers) may share one `elementKey`. A memo keyed
 *    only by the element's version hands the second entry the first entry's cached
 *    snapshot, `entryId` and all.
 *  - the **transform** — world `bounds` are computed from the element→coordinate-
 *    system matrix. Reuse an element under a new `Matrix4` and the bounds are stale.
 *  - the **config signature** — a resolver may derive notices or resources from
 *    `ctx.config` (points do: the truncation notice depends on the selection).
 *
 * So the cache key is `(entryId, version, transform identity, configSig)`. Keying
 * by `entryId` also means a not-yet-loaded entry (absent from the element cache)
 * is still identity-stable across renders — which the flip's `project()` memo
 * needs even before data arrives.
 *
 * ## Purity
 *
 * `snapshot()` writing here is a read-side memo, exactly like the old engine's
 * `getResource` caching into its entry. It never bumps the version and never
 * notifies, so it cannot drive a re-render. It is not referentially transparent —
 * but neither was the code it replaces, and identity stability is the whole point.
 *
 * ## Cleanup
 *
 * The memo is keyed by `entryId`, but eviction is by `elementKey`, so
 * {@link evictByElement} scans. Eviction is rare (unload / dataset switch); the
 * scan is cheap and keeps the cache from leaking entryIds whose element is gone.
 */
export class SnapshotCache {
  private readonly cache = new Map<
    string,
    { version: number; transform: unknown; configSig: string; value: EntryResources }
  >();

  /** The cached snapshot for this entry, or `undefined` if any input changed. */
  get(
    entryId: string,
    version: number,
    transform: unknown,
    configSig: string
  ): EntryResources | undefined {
    const hit = this.cache.get(entryId);
    if (
      hit &&
      hit.version === version &&
      hit.transform === transform &&
      hit.configSig === configSig
    ) {
      return hit.value;
    }
    return undefined;
  }

  set(
    entryId: string,
    version: number,
    transform: unknown,
    configSig: string,
    value: EntryResources
  ): void {
    this.cache.set(entryId, { version, transform, configSig, value });
  }

  /** Drop every memo whose snapshot was for this element. */
  evictByElement(elementKey: string): void {
    for (const [entryId, record] of this.cache) {
      if (record.value.elementKey === elementKey) {
        this.cache.delete(entryId);
      }
    }
  }

  clear(): void {
    this.cache.clear();
  }
}
