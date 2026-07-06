import type { PointsElement, PointsLoadResult } from '@spatialdata/core';
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
 * Parity scope: this mirrors the current branch's *preloaded flat scatter* path
 * only. Metadata probing, Morton tiling, feature catalog/codes, and tile-debug
 * state are deliberately NOT here yet — they are the dark capabilities that MVP
 * steps 2–4 will wire *into this engine* (see docs/plans/points-mvp-and-roadmap).
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

  /** Drop an element from the cache (on unload / dataset switch). */
  evict(key: string): void {
    this.entries.delete(key);
  }

  /** Release all cached data and listeners. */
  dispose(): void {
    this.entries.clear();
    this.listeners.clear();
  }
}
