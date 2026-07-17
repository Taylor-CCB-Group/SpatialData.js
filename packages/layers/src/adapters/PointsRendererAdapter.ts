import type { PointsElement, PointsLoadResult } from '@spatialdata/core';
import {
  columnarBatchFromPointData,
  type PointsLoader,
  type PointsRenderResource,
} from '../pointsLoader.js';
import {
  pointsRenderResourceSignature,
  resolvePointsRenderResource,
} from '../resolvePointsRenderResource.js';

/**
 * The deck Renderer Adapter for points: the three render-resource memos.
 *
 * These used to live inside `PointsDataEngine`, memoising lazily on read because
 * their only caller was React's render phase. ADR 0004 §4 puts them here instead:
 * *"identity-stable memoisation is a **deck requirement** — deck tears a layer down
 * when its data identity changes — so it belongs on the renderer side."*
 *
 * Nothing was deleted. The memo was **rescheduled**, not removed: from "lazily,
 * whenever a getter is first called this frame" to "eagerly, once, at the end of
 * reconcile". The `PointsResolver` in `core` now owns the *data*; this owns the
 * *identity* the renderer needs.
 *
 * ## Why these memos key on object identity, and the old ones could not
 *
 * `pointsRenderResourceSignature` keys on the batch's row **count**, not its
 * identity — two different batches with the same row count produce the same
 * signature. That is why the old engine had to reach in and manually null
 * `entry.resource` on every swap and every in-memory shed: the signature alone
 * would happily serve a stale resource.
 *
 * Once the memo lives outside the entry that manual invalidation is not available
 * — so these memos key on the batch **object identity** as well. That is exact:
 * `PointsResolver` always *replaces* a batch, never mutates one in place. Identity
 * changes precisely when the data changes, and never otherwise. The bookkeeping
 * disappears, and with it the class of bug where someone adds a new mutation path
 * and forgets to invalidate.
 *
 * The signature is still checked, because it also captures the element key and the
 * resolve options — things identity alone would miss.
 */

interface ResourceMemo {
  /** The batch this resource was built from. Identity is the invalidation key. */
  source: PointsLoadResult;
  /** Also checked: catches element/option changes that identity alone would miss. */
  signature: string;
  resource: PointsRenderResource;
}

interface EntryMemos {
  resident?: ResourceMemo;
  matched?: ResourceMemo;
}

/**
 * The streaming overlay's resource (D10). Unlike the resident/matched memos — which
 * key on batch IDENTITY and so mint a new resource whenever the batch changes — the
 * partial's resource is held **stable for the lifetime of one scan** and its backing
 * batch is swapped through a mutable holder, with a `revision` counter bumped on each
 * growth. That is what stops `PointsLayer` tearing the `__partial` sublayer down and
 * rebuilding it per chunk (the flash): the loader identity never changes mid-scan, so
 * the composite re-reads the grown buffer on a `resourceRevision` prop change instead
 * of resetting.
 */
interface GrowingPartial {
  /** The scan this partial belongs to (`${signature}#${cap}`); a change means a new scan. */
  scanKey: string;
  resource: PointsRenderResource;
  /** Swapped per chunk; the loader's `loadAll` reads through it. */
  holder: { current: PointsLoadResult };
  revision: number;
}

const RESOLVE_OPTIONS = { experimentalOptimizations: 'off' as const };

/** A batch with no points must not produce a resource — see the empty-lock guard below. */
const isEmpty = (batch: PointsLoadResult): boolean => (batch.shape[1] ?? 0) === 0;

export class PointsRendererAdapter {
  private readonly memos = new Map<string, EntryMemos>();
  private readonly growingPartials = new Map<string, GrowingPartial>();
  /** The base layer's stable resource per element — see {@link getBaseResource}. */
  private readonly growingBases = new Map<
    string,
    { resource: PointsRenderResource; holder: { current: PointsLoadResult }; revision: number }
  >();

  private entry(key: string): EntryMemos {
    let memos = this.memos.get(key);
    if (!memos) {
      memos = {};
      this.memos.set(key, memos);
    }
    return memos;
  }

  private resolve(
    memos: EntryMemos,
    slot: keyof EntryMemos,
    element: PointsElement,
    batch: PointsLoadResult
  ): PointsRenderResource | null {
    const cache = { preloaded: batch, metadataKnown: false };
    const signature = pointsRenderResourceSignature(element, cache, RESOLVE_OPTIONS);
    const memo = memos[slot];
    if (memo && memo.source === batch && memo.signature === signature) {
      return memo.resource;
    }
    const resource = resolvePointsRenderResource(element, cache, RESOLVE_OPTIONS);
    if (resource) {
      memos[slot] = { source: batch, signature, resource };
    }
    return resource;
  }

  /**
   * The resident preload's render resource. Stable across renders and pans, so the
   * `PointsLayer` composite does not reset its async-loaded batch — resolving afresh
   * per call would blank the layer for a frame (the pan flash).
   */
  getResource(element: PointsElement, key: string, batch: PointsLoadResult | undefined) {
    if (!batch) return null;
    return this.resolve(this.entry(key), 'resident', element, batch);
  }

  /**
   * The matched selection's render resource.
   *
   * Empty-lock guard: a scan that matched no rows must NOT supersede the resident
   * preview, or the render locks to an empty batch with no way to recover — the
   * settled selection never re-scans. Returning null falls back to resident
   * filtering. A legitimately empty selection cannot reach here: an empty
   * `featureCodes` selection short-circuits before any scan is kicked.
   */
  getMatchingResource(element: PointsElement, key: string, batch: PointsLoadResult | undefined) {
    if (!batch || isEmpty(batch)) return null;
    return this.resolve(this.entry(key), 'matched', element, batch);
  }

  /**
   * The in-flight scan's growing buffer, as a resource (D10).
   *
   * The resource identity is **held stable for the whole scan** (keyed on `scanKey`,
   * not the batch): a grown buffer swaps the mutable holder and bumps
   * {@link getMatchingPartialRevision} instead of minting a new resource. So the
   * `PointsLayer` composite is NOT torn down per chunk — it re-reads the grown buffer
   * on a `resourceRevision` prop change. One deck layer per *(entry, selection)*,
   * zero teardowns per scan. A new scan (`scanKey` change) mints a fresh resource.
   */
  getMatchingPartialResource(
    element: PointsElement,
    key: string,
    batch: PointsLoadResult | undefined,
    scanKey: string | undefined
  ): PointsRenderResource | null {
    if (!batch || isEmpty(batch) || scanKey === undefined) {
      this.growingPartials.delete(key);
      return null;
    }
    let growing = this.growingPartials.get(key);
    if (!growing || growing.scanKey !== scanKey) {
      // New scan → build ONE resource whose loader reads through a mutable holder.
      const holder = { current: batch };
      const resource = this.buildGrowingResource(element, holder);
      if (!resource) return null;
      growing = { scanKey, resource, holder, revision: 0 };
      this.growingPartials.set(key, growing);
    } else if (growing.holder.current !== batch) {
      // Same scan, grown buffer → swap the holder + bump the revision. SAME resource.
      growing.holder.current = batch;
      growing.revision += 1;
    }
    return growing.resource;
  }

  /** The revision of the in-flight partial's growing buffer — a `PointsLayer`
   * `resourceRevision` prop, bumped each time the buffer grows so the composite
   * re-reads without a teardown. */
  getMatchingPartialRevision(key: string): number {
    return this.growingPartials.get(key)?.revision ?? 0;
  }

  /**
   * The **base** layer's render resource — ONE stable resource per element whose
   * backing batch evolves.
   *
   * The base's "current best view" changes over an element's life: the resident
   * preload (streaming in during initial load), that preload filtered to a selection,
   * then the whole-dataset matched batch once a scan covers the selection. Each of
   * those is a *different* batch, and the old code drew them under one `id: layerId`
   * from two different resources (resident vs matched) — so every transition changed
   * the loader identity and `PointsLayer` hard-reset (the base flash).
   *
   * Here the resource identity is fixed for the element (built once, from the first
   * batch); a new batch swaps the mutable holder and bumps {@link getBaseRevision},
   * and `PointsLayer` re-reads `loadAll` on that revision change WITHOUT resetting. No
   * teardown across resident↔matched↔streaming transitions. Callers choose the batch
   * (matched-if-covered else resident) and pass the matching `preloadedFeatureCodes`.
   */
  getBaseResource(
    element: PointsElement,
    key: string,
    batch: PointsLoadResult | undefined
  ): PointsRenderResource | null {
    if (!batch || isEmpty(batch)) {
      this.growingBases.delete(key);
      return null;
    }
    let growing = this.growingBases.get(key);
    if (!growing) {
      const holder = { current: batch };
      const resource = this.buildGrowingResource(element, holder);
      if (!resource) return null;
      growing = { resource, holder, revision: 0 };
      this.growingBases.set(key, growing);
    } else if (growing.holder.current !== batch) {
      growing.holder.current = batch;
      growing.revision += 1;
    }
    return growing.resource;
  }

  /** The base resource's revision — a `PointsLayer` `resourceRevision` prop, bumped
   * each time the base batch is swapped (resident↔matched↔streaming) so the composite
   * re-reads without a teardown. */
  getBaseRevision(key: string): number {
    return this.growingBases.get(key)?.revision ?? 0;
  }

  /** A stable render resource whose `loadAll` reads the current holder batch. */
  private buildGrowingResource(
    element: PointsElement,
    holder: { current: PointsLoadResult }
  ): PointsRenderResource | null {
    const base = resolvePointsRenderResource(
      element,
      { preloaded: holder.current, metadataKnown: false },
      RESOLVE_OPTIONS
    );
    if (!base) return null;
    const loader: PointsLoader = {
      capabilities: base.loader.capabilities,
      loadInBounds: (options) => base.loader.loadInBounds(options),
      loadAll: async () =>
        columnarBatchFromPointData({
          shape: holder.current.shape,
          data: holder.current.data,
          ...(holder.current.featureCodes ? { featureCodes: holder.current.featureCodes } : {}),
        }),
    };
    return { element, loader };
  }

  evict(key: string): void {
    this.memos.delete(key);
    this.growingPartials.delete(key);
    this.growingBases.delete(key);
  }

  dispose(): void {
    this.memos.clear();
    this.growingPartials.clear();
    this.growingBases.clear();
  }
}
