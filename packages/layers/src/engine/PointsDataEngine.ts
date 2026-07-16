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

  /** Render resource for the in-flight scan's growing partial buffer. */
  getMatchingPartialResource(element: PointsElement, key: string): PointsRenderResource | null {
    return this.adapter.getMatchingPartialResource(
      element,
      key,
      this.resolver.getPartialBatch(key)
    );
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
  }

  dispose(): void {
    this.resolver.dispose();
    this.adapter.dispose();
  }
}
