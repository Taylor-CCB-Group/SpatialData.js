import type { PointsElement, PointsFeatureCatalog, PointsLoadResult } from '@spatialdata/core';
import { pointsRenderResourceSignature, resolvePointsRenderResource } from '../resolvePointsRenderResource.js';
import type { PointsRenderResource } from '../pointsLoader.js';

/**
 * Framework-agnostic points loading/caching/resolution engine.
 *
 * This is step 1b of the LayerDataEngine decomposition: the points-only
 * sub-engine, extracted from the `@spatialdata/vis` `useLayerData` hook so the
 * cache + orchestration live in React-free `@spatialdata/layers` and can be
 * unit-tested headlessly. It owns exactly what the hook's points path used to
 * hold as `useRef` state:
 *
 *  - the per-element preloaded batch cache (`loadedDataRef.points`),
 *  - the stable render-resource memo (`stablePointsResourceRef`),
 *  - the async preload orchestration (the load effect's points branch).
 *
 * Scope: the *preloaded flat scatter* path plus the **feature catalog** and
 * **row feature codes** that MVP step 2 (feature filter) needs. Metadata
 * probing, Morton tiling, and tile-debug state are still dark — later MVP steps
 * wire them *into this engine* (see docs/plans/points-mvp-and-roadmap).
 *
 * Alignment invariant (load-bearing): `getRowFeatureCodes(key)` is row-aligned
 * with the resident batch from `ensureLoaded`. Both the geometry preload
 * (`element.loadPoints()`) and the row codes (`element.loadRowFeatureCodes()`)
 * read the first `min(rowCount, memoryCap)` rows in *file order* under the same
 * default memory cap, so index i in the codes array names the feature of point i
 * in the batch. If a configurable memory cap is ever threaded, it MUST go to
 * both calls identically or the filter mask will be misaligned.
 */

export type PointsLoadStatus = 'idle' | 'loading' | 'ready' | 'error';

export interface PointsLoadTarget {
  /** Stable element key — the cache/resolver key. */
  key: string;
  /** Layer id, used only to report status back to the host. */
  layerId: string;
  element: PointsElement;
}

export interface PointsDataEngineCallbacks {
  /** Report load-status transitions so the host can drive its load-state UI. */
  onStatus?: (layerId: string, status: PointsLoadStatus) => void;
}

interface PointsEntry {
  data?: PointsLoadResult;
  status: PointsLoadStatus;
  loading?: Promise<void>;
  resource?: { signature: string; resource: PointsRenderResource };
  /** Feature catalog: `undefined` while unloaded, `null` once settled for an
   * element with no `feature_key`, else the catalog. `catalogLoaded` disambiguates
   * "not yet requested" from "settled as null". */
  catalog?: PointsFeatureCatalog | null;
  catalogLoaded?: boolean;
  catalogLoading?: Promise<void>;
  /** Per-row feature codes aligned to the resident batch (see class doc). Value
   * is `undefined` when the element exposes no feature codes; `rowCodesLoaded`
   * marks the settled state. */
  rowCodes?: ArrayLike<number>;
  rowCodesLoaded?: boolean;
  rowCodesLoading?: Promise<void>;
}

export class PointsDataEngine {
  private readonly entries = new Map<string, PointsEntry>();
  private readonly listeners = new Set<() => void>();
  private readonly callbacks: PointsDataEngineCallbacks;

  constructor(callbacks: PointsDataEngineCallbacks = {}) {
    this.callbacks = callbacks;
  }

  /** Subscribe to cache mutations (async load settled). Returns an unsubscribe. */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private notify(): void {
    for (const listener of this.listeners) {
      listener();
    }
  }

  hasData(key: string): boolean {
    return this.entries.get(key)?.data !== undefined;
  }

  getData(key: string): PointsLoadResult | undefined {
    return this.entries.get(key)?.data;
  }

  getStatus(key: string): PointsLoadStatus {
    return this.entries.get(key)?.status ?? 'idle';
  }

  /**
   * Resolve a **stable** render resource for an element. Memoized by signature
   * so repeated calls (every render / pan-zoom frame) reuse the same loader
   * identity: the `PointsLayer` composite resets its async-loaded batch whenever
   * the loader identity changes, which would blank the layer for a frame (the
   * pan flash) if we resolved afresh each call. Returns null until data loads.
   */
  getResource(element: PointsElement, key: string): PointsRenderResource | null {
    const entry = this.entries.get(key);
    if (!entry?.data) {
      return null;
    }
    const cache = { preloaded: entry.data, metadataKnown: false };
    const options = { experimentalOptimizations: 'off' as const };
    const signature = pointsRenderResourceSignature(element, cache, options);
    if (entry.resource && entry.resource.signature === signature) {
      return entry.resource.resource;
    }
    const resource = resolvePointsRenderResource(element, cache, options);
    if (resource) {
      entry.resource = { signature, resource };
    }
    return resource;
  }

  /**
   * Idempotently preload an element's points. No-op if already loaded or a load
   * is in flight; the returned promise resolves when the (possibly already
   * running) load settles. Status transitions are reported via `onStatus`; the
   * cache mutation notifies subscribers.
   */
  ensureLoaded(target: PointsLoadTarget): Promise<void> {
    const { key, layerId, element } = target;
    const existing = this.entries.get(key);
    if (existing?.data !== undefined) {
      return Promise.resolve();
    }
    if (existing?.loading) {
      return existing.loading;
    }

    const entry: PointsEntry = existing ?? { status: 'idle' };
    entry.status = 'loading';
    this.entries.set(key, entry);
    this.callbacks.onStatus?.(layerId, 'loading');

    const loading = (async () => {
      try {
        const data = await element.loadPoints();
        entry.data = data;
        entry.status = 'ready';
        this.callbacks.onStatus?.(layerId, 'ready');
      } catch (error) {
        entry.status = 'error';
        this.callbacks.onStatus?.(layerId, 'error');
        console.error(`Failed to load points for ${layerId}:`, error);
      } finally {
        entry.loading = undefined;
        this.notify();
      }
    })();
    entry.loading = loading;
    return loading;
  }

  // --- Feature catalog (MVP step 2: feature filter) --------------------------

  /**
   * The feature catalog for an element: `undefined` until settled, then `null`
   * for an element with no `feature_key`, else the catalog. Reactive via
   * `subscribe` — a settled load calls `notify()`.
   */
  getFeatureCatalog(key: string): PointsFeatureCatalog | null | undefined {
    const entry = this.entries.get(key);
    return entry?.catalogLoaded ? (entry.catalog ?? null) : undefined;
  }

  isFeatureCatalogLoading(key: string): boolean {
    return this.entries.get(key)?.catalogLoading !== undefined;
  }

  /**
   * Idempotently build the feature catalog (feature-column scan; worker-offloaded
   * for oversized datasets). No-op once settled or in flight. Uses
   * `listFeaturesWithCounts` so the panel can show/sort by per-feature counts.
   */
  ensureFeatureCatalog(target: PointsLoadTarget): Promise<void> {
    const { key, element } = target;
    const entry = this.entries.get(key) ?? { status: 'idle' as PointsLoadStatus };
    this.entries.set(key, entry);
    if (entry.catalogLoaded) {
      return Promise.resolve();
    }
    if (entry.catalogLoading) {
      return entry.catalogLoading;
    }

    const loading = (async () => {
      try {
        entry.catalog = await element.listFeaturesWithCounts();
      } catch (error) {
        entry.catalog = null;
        console.error(`Failed to build points feature catalog for ${target.layerId}:`, error);
      } finally {
        entry.catalogLoaded = true;
        entry.catalogLoading = undefined;
        this.notify();
      }
    })();
    entry.catalogLoading = loading;
    this.notify(); // surface the loading transition to the panel
    return loading;
  }

  // --- Row feature codes (the filter mask, aligned to the resident batch) -----

  /** Per-row feature codes aligned to the resident batch, or `undefined` if the
   * element exposes none / they are not yet loaded. See the class-doc alignment
   * invariant. */
  getRowFeatureCodes(key: string): ArrayLike<number> | undefined {
    return this.entries.get(key)?.rowCodes;
  }

  /** True once row codes have settled (even if the element has none). */
  hasRowFeatureCodes(key: string): boolean {
    return this.entries.get(key)?.rowCodesLoaded === true;
  }

  /**
   * Idempotently load the row feature codes for the resident batch. Reuses the
   * engine's catalog for name→code mapping when it is already built (else the
   * core loader scans it internally). No-op once settled or in flight.
   */
  ensureRowFeatureCodes(target: PointsLoadTarget): Promise<void> {
    const { key, element } = target;
    const entry = this.entries.get(key) ?? { status: 'idle' as PointsLoadStatus };
    this.entries.set(key, entry);
    if (entry.rowCodesLoaded) {
      return Promise.resolve();
    }
    if (entry.rowCodesLoading) {
      return entry.rowCodesLoading;
    }

    const loading = (async () => {
      try {
        entry.rowCodes = await element.loadRowFeatureCodes({
          featureCatalog: this.getFeatureCatalog(key),
        });
      } catch (error) {
        entry.rowCodes = undefined;
        console.error(`Failed to load points row feature codes for ${target.layerId}:`, error);
      } finally {
        entry.rowCodesLoaded = true;
        entry.rowCodesLoading = undefined;
        this.notify();
      }
    })();
    entry.rowCodesLoading = loading;
    return loading;
  }

  /** Drop an element from the cache (on unload / dataset switch). Catalog and row
   * codes live in the same entry, so they are evicted together. */
  evict(key: string): void {
    this.entries.delete(key);
  }

  /** Release all cached data and listeners. */
  dispose(): void {
    this.entries.clear();
    this.listeners.clear();
  }
}
