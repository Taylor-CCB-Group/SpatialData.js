import {
  type PointsElement,
  type PointsFeatureCatalog,
  type PointsLoadResult,
  PointsResolver,
} from '@spatialdata/core';
import { PointsRendererAdapter } from '../adapters/PointsRendererAdapter.js';
import type { PointsRenderResource } from '../pointsLoader.js';

/**
 * `PointsDataEngine` — now a **facade** over `PointsResolver` (`core`) and
 * `PointsRendererAdapter` (`layers`).
 *
 * The class is split, not deleted, and its surface is unchanged. That is not
 * timidity — it is the compat contract. `pointsEngine` is member 8 of
 * `useLayerData`'s seventeen, and `PointsFeatureState.tsx` calls ten of these
 * methods directly. Keeping the facade is what lets the split land without
 * touching the panels, the 845-line `pointsDataEngine.spec.ts`, or MDV.
 *
 * **The acceptance test for the split is that `pointsDataEngine.spec.ts` passes
 * unchanged, byte for byte.** If it doesn't, the split is wrong.
 *
 * ## The split
 *
 * - **`PointsResolver` (`core`)** — the cache and lifecycle: the resident preload,
 *   the feature catalog, the per-row codes, the feature-index scan. Framework-free,
 *   so `tgpu-htj2k` can consume it. (ADR 0004 §1.)
 * - **`PointsRendererAdapter` (`layers`)** — the three render-resource memos.
 *   Identity-stable memoisation is a *deck* requirement, so it lives on the
 *   renderer side. (ADR 0004 §4.)
 *
 * The facade holds both and routes each call to the half that owns it. The resource
 * getters read the resolver's batch and hand it to the adapter, which memoises on
 * that batch's identity — so `getResource(element, key)` twice in a row still
 * returns the same object, exactly as before.
 *
 * ## Retiring this
 *
 * Step 3. Once `useLayerData` reads a resolver snapshot and the panels read from
 * `project()`, nothing needs a live engine handle and this file goes away. Until
 * then it is load-bearing, and its surface is a promise.
 */

export type {
  PointsLoadStatus,
  PointsLoadTarget,
  PointsMatchingLoadState,
} from '@spatialdata/core';

import type {
  PointsLoadStatus,
  PointsLoadTarget,
  PointsMatchingLoadState,
  PointsResolverCallbacks,
} from '@spatialdata/core';

export type PointsDataEngineCallbacks = PointsResolverCallbacks;

export class PointsDataEngine {
  private readonly resolver: PointsResolver;
  private readonly adapter = new PointsRendererAdapter();
  /** Memo for {@link getFeatureCodeSpaceSize}, invalidated by catalog identity. */
  private readonly codeSpaceMemo = new Map<
    string,
    { catalog: PointsFeatureCatalog | null | undefined; size: number }
  >();

  constructor(callbacks: PointsDataEngineCallbacks = {}) {
    this.resolver = new PointsResolver(callbacks);
  }

  /** The underlying resolver, for callers that have migrated off the facade. */
  get resourceResolver(): PointsResolver {
    return this.resolver;
  }

  // --- Subscription -----------------------------------------------------------

  subscribe(listener: () => void): () => void {
    return this.resolver.subscribe(listener);
  }

  getVersion(): number {
    return this.resolver.getVersion();
  }

  // --- Render resources (adapter-owned) ---------------------------------------

  /**
   * Resolve a **stable** render resource for an element. Memoised on the resident
   * batch's identity, so repeated calls (every render / pan-zoom frame) reuse the
   * same loader identity: `PointsLayer` resets its async-loaded batch whenever the
   * loader identity changes, which would blank the layer for a frame. Null until
   * data loads.
   */
  getResource(element: PointsElement, key: string): PointsRenderResource | null {
    return this.adapter.getResource(element, key, this.resolver.getData(key));
  }

  /** Render resource for the settled matched-selection batch. */
  getMatchingResource(element: PointsElement, key: string): PointsRenderResource | null {
    return this.adapter.getMatchingResource(element, key, this.resolver.getMatchedBatch(key));
  }

  /** Render resource for the in-flight scan's growing partial buffer. Identity is
   * stable for the scan's lifetime (D10); {@link getMatchingPartialRevision} bumps
   * as it grows. */
  getMatchingPartialResource(element: PointsElement, key: string): PointsRenderResource | null {
    return this.adapter.getMatchingPartialResource(
      element,
      key,
      this.resolver.getPartialBatch(key),
      this.resolver.getPartialScanKey(key)
    );
  }

  /** The growing partial's revision — a `PointsLayer` `resourceRevision` prop, so the
   * `__partial` sublayer re-reads the grown buffer without a per-chunk teardown. */
  getMatchingPartialRevision(key: string): number {
    return this.adapter.getMatchingPartialRevision(key);
  }

  /**
   * The BASE layer's stable render resource for a chosen batch (matched-if-covered
   * else resident — the caller decides). Identity is fixed for the element; the batch
   * swaps under it (see {@link getBaseRevision}), so the base never tears down across
   * resident↔matched↔streaming transitions.
   */
  getBaseResource(
    element: PointsElement,
    key: string,
    batch: PointsLoadResult | undefined
  ): PointsRenderResource | null {
    return this.adapter.getBaseResource(element, key, batch);
  }

  /** The base resource's revision — a `PointsLayer` `resourceRevision` prop. */
  getBaseRevision(key: string): number {
    return this.adapter.getBaseRevision(key);
  }

  // --- Lifecycle (resolver-owned) ---------------------------------------------

  ensureLoaded(target: PointsLoadTarget, memoryCap?: number): Promise<void> {
    return memoryCap === undefined
      ? this.resolver.ensureLoaded(target)
      : this.resolver.ensureLoaded(target, memoryCap);
  }

  ensureMatchingFeaturesLoaded(
    target: PointsLoadTarget,
    featureCodes: readonly number[],
    memoryCap?: number
  ): Promise<void> {
    return memoryCap === undefined
      ? this.resolver.ensureMatchingFeaturesLoaded(target, featureCodes)
      : this.resolver.ensureMatchingFeaturesLoaded(target, featureCodes, memoryCap);
  }

  ensureFeatureCatalog(target: PointsLoadTarget): Promise<void> {
    return this.resolver.ensureFeatureCatalog(target);
  }

  ensureRowFeatureCodes(target: PointsLoadTarget): Promise<void> {
    return this.resolver.ensureRowFeatureCodes(target);
  }

  // --- Reads (resolver-owned) -------------------------------------------------

  hasData(key: string): boolean {
    return this.resolver.hasData(key);
  }

  getData(key: string): PointsLoadResult | undefined {
    return this.resolver.getData(key);
  }

  /** The last-good matched-selection batch (whole-dataset scan result). */
  getMatchedBatch(key: string): PointsLoadResult | undefined {
    return this.resolver.getMatchedBatch(key);
  }

  getStatus(key: string): PointsLoadStatus {
    return this.resolver.getStatus(key);
  }

  isLoadedWithCap(key: string, memoryCap: number): boolean {
    return this.resolver.isLoadedWithCap(key, memoryCap);
  }

  getResidentTruncation(key: string) {
    return this.resolver.getResidentTruncation(key);
  }

  getActiveTruncation(key: string, featureCodes: readonly number[] | undefined) {
    return this.resolver.getActiveTruncation(key, featureCodes);
  }

  getMatchingLoadState(
    key: string,
    featureCodes: readonly number[]
  ): PointsMatchingLoadState | undefined {
    return this.resolver.getMatchingLoadState(key, featureCodes);
  }

  isMatchingLoading(key: string, featureCodes: readonly number[]): boolean {
    return this.resolver.isMatchingLoading(key, featureCodes);
  }

  getLoadedMatchingFeatureCodes(key: string): ReadonlySet<number> | undefined {
    return this.resolver.getLoadedMatchingFeatureCodes(key);
  }

  getMatchingRowFeatureCodes(key: string): ArrayLike<number> | undefined {
    return this.resolver.getMatchingRowFeatureCodes(key);
  }

  getMatchingPartialRowFeatureCodes(key: string): ArrayLike<number> | undefined {
    return this.resolver.getMatchingPartialRowFeatureCodes(key);
  }

  getFeatureCatalog(key: string): PointsFeatureCatalog | null | undefined {
    return this.resolver.getFeatureCatalog(key);
  }

  /**
   * The feature-code space size — `maxCode + 1` across the catalog, i.e. the width the
   * colour LUT must cover so every point's code indexes a real texel. 0 until a catalog
   * loads. Memoised on catalog identity (the resolver replaces it, never mutates), so
   * this is O(entries) only when the catalog changes — cheap enough for the per-frame
   * `getLayers`.
   */
  getFeatureCodeSpaceSize(key: string): number {
    const catalog = this.resolver.getFeatureCatalog(key);
    const cached = this.codeSpaceMemo.get(key);
    if (cached && cached.catalog === catalog) {
      return cached.size;
    }
    let size = 0;
    if (catalog) {
      for (const entry of catalog.entries) {
        if (entry.code + 1 > size) {
          size = entry.code + 1;
        }
      }
    }
    this.codeSpaceMemo.set(key, { catalog, size });
    return size;
  }

  isFeatureCatalogLoading(key: string): boolean {
    return this.resolver.isFeatureCatalogLoading(key);
  }

  isFeatureCatalogRefining(key: string): boolean {
    return this.resolver.isFeatureCatalogRefining(key);
  }

  hasFeatureCodeColumn(key: string): boolean {
    return this.resolver.hasFeatureCodeColumn(key);
  }

  supportsFeatureScan(key: string): boolean {
    return this.resolver.supportsFeatureScan(key);
  }

  getResidentFeatureCodes(key: string): ReadonlySet<number> | undefined {
    return this.resolver.getResidentFeatureCodes(key);
  }

  getRowFeatureCodes(key: string): ArrayLike<number> | undefined {
    return this.resolver.getRowFeatureCodes(key);
  }

  hasRowFeatureCodes(key: string): boolean {
    return this.resolver.hasRowFeatureCodes(key);
  }

  /** Re-run any failed resources of an element (e.g. a stuck full-catalog scan). */
  retry(key: string): Promise<void> {
    return this.resolver.retry(key);
  }

  // --- Lifecycle --------------------------------------------------------------

  /** Drop an element from both halves — the data AND the resources built from it. */
  evict(key: string): void {
    this.resolver.evict(key);
    this.adapter.evict(key);
    this.codeSpaceMemo.delete(key);
  }

  dispose(): void {
    this.resolver.dispose();
    this.adapter.dispose();
    this.codeSpaceMemo.clear();
  }
}
