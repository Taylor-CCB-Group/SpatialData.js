import type { PointsElement, PointsLoadResult } from '@spatialdata/core';
import type { PointsRenderResource } from '../pointsLoader.js';
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
  partial?: ResourceMemo;
}

const RESOLVE_OPTIONS = { experimentalOptimizations: 'off' as const };

/** A batch with no points must not produce a resource — see the empty-lock guard below. */
const isEmpty = (batch: PointsLoadResult): boolean => (batch.shape[1] ?? 0) === 0;

export class PointsRendererAdapter {
  private readonly memos = new Map<string, EntryMemos>();

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
   * The in-flight scan's growing buffer, as a resource, so points progressively
   * fill in before the full scan settles. Rebuilds only when a new chunk grows the
   * buffer — not per pan, which is when the user is most likely to be moving.
   */
  getMatchingPartialResource(
    element: PointsElement,
    key: string,
    batch: PointsLoadResult | undefined
  ) {
    if (!batch || isEmpty(batch)) return null;
    return this.resolve(this.entry(key), 'partial', element, batch);
  }

  evict(key: string): void {
    this.memos.delete(key);
  }

  dispose(): void {
    this.memos.clear();
  }
}
