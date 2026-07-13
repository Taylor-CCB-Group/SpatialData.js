import {
  DEFAULT_POINTS_MEMORY_CAP,
  featureCodeMapFromCatalog,
  remapRowFeatureCodes,
  type PointsElement,
  type PointsFeatureCatalog,
  type PointsLoadProgress,
  type PointsLoadResult,
} from '@spatialdata/core';
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
  /** Memory cap (max resident rows) the current `data`/`loading` was requested
   * with. A change means the resident window must reload — see `ensureLoaded`. */
  memoryCap?: number;
  /** Aborts the in-flight preload when it is superseded (a cap change), so a
   * stale load doesn't run its expensive main-thread fallback to completion. */
  loadAbort?: AbortController;
  status: PointsLoadStatus;
  loading?: Promise<void>;
  resource?: { signature: string; resource: PointsRenderResource };
  /** Feature catalog: `undefined` while unloaded, `null` once settled for an
   * element with no `feature_key`, else the catalog. `catalogLoaded` disambiguates
   * "not yet requested" from "settled as null". */
  catalog?: PointsFeatureCatalog | null;
  catalogLoaded?: boolean;
  catalogLoading?: Promise<void>;
  /** True once the full-dataset catalog scan (`listFeaturesWithCounts`) has
   * replaced any resident-subset preview. Until then `catalog` may reflect only
   * the resident batch, so the full scan is allowed to run and supersede it. */
  catalogComplete?: boolean;
  /** Per-row feature codes aligned to the resident batch (see class doc). Value
   * is `undefined` when the element exposes no feature codes; `rowCodesLoaded`
   * marks the settled state. */
  rowCodes?: ArrayLike<number>;
  rowCodesLoaded?: boolean;
  rowCodesLoading?: Promise<void>;
  /** The catalog whose code space {@link rowCodes} are expressed in. When the
   * catalog is upgraded (resident preview → full-dataset), `reconcileRowCodes`
   * remaps `rowCodes` into the new space and updates this — keeping the render's
   * per-row codes aligned with the panel's selection codes for dictionary-only
   * datasets, where codes are app-assigned and can differ between catalog builds. */
  rowCodesCatalog?: PointsFeatureCatalog;
  /** True when the element has a file-backed feature code column (authoritative
   * codes; a real feature index). Undefined until the resident batch loads; false
   * for dictionary-only feature columns. Gates the whole-dataset feature-index
   * scan — see {@link hasFeatureCodeColumn}. */
  featureCodeColumn?: boolean;
  /** Memoized distinct codes in {@link rowCodes}, invalidated by identity via
   * `residentCodesSource` (see `getResidentFeatureCodes`). */
  residentCodes?: ReadonlySet<number>;
  residentCodesSource?: ArrayLike<number>;
  /** Whole-dataset points for the active selection, loaded via the feature-index
   * scan and keyed by the selected-codes `signature` so a selection change
   * rebuilds it. `resource` is the stable render resource, built lazily. */
  matching?: { signature: string; result: PointsLoadResult; resource?: PointsRenderResource };
  /** In-flight feature-index scan, with progressive counts updated from the
   * scan's `onProgress` so the panel can show partial stats as they accumulate. */
  matchingLoading?: {
    signature: string;
    promise: Promise<void>;
    matchedRows: number;
    scannedRows: number;
    partialResult?: PointsLoadResult;
    /** SPIKE: render resource built from `partialResult`, cached on that chunk's
     * identity so it only rebuilds when a new chunk arrives (not every pan). */
    partialResource?: { source: PointsLoadResult; resource: PointsRenderResource };
  };
}

/** Public snapshot of a selection's feature-index load, for the filter panel. */
export interface PointsMatchingLoadState {
  /** The scan for this exact selection is in flight. */
  loading: boolean;
  /** Matched points so far (progressive while loading; final once settled). */
  matchedRows: number;
  /** Rows examined so far (progressive while loading; final once settled). */
  scannedRows: number;
  /** True once the scan for this selection has settled. */
  settled: boolean;
  /** The selection is served by filtering a larger in-memory batch (a removal
   * reused it — no scan ran). `matchedRows` is then the whole batch, not the
   * drawn subset, so the panel words it as "served from memory". */
  covered?: boolean;
}

export class PointsDataEngine {
  private readonly entries = new Map<string, PointsEntry>();
  private readonly listeners = new Set<() => void>();
  private readonly callbacks: PointsDataEngineCallbacks;
  /** Monotonic cache-mutation counter. Backs a `useSyncExternalStore` snapshot so
   * React reliably re-renders on every settled load — including late async
   * completions (e.g. the full-dataset catalog scan) that a plain subscribe →
   * bump-a-counter → pull-during-render pattern was dropping. */
  private version = 0;

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

  /** Snapshot for `useSyncExternalStore`: changes on every {@link notify}. */
  getVersion(): number {
    return this.version;
  }

  private notify(): void {
    this.version += 1;
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

  // --- Feature-index render scan (whole-dataset load of a selection) ----------

  /** Order-independent cache key for a selected-codes set. */
  private static matchingSignature(featureCodes: readonly number[]): string {
    return [...featureCodes].sort((left, right) => left - right).join(',');
  }

  /** Feature codes a matched batch/scan covers, parsed from its signature
   * (sorted-codes-joined; `''` → the empty selection). */
  private static coveredCodes(signature: string): Set<number> {
    if (signature === '') {
      return new Set();
    }
    return new Set(signature.split(',').map(Number));
  }

  /**
   * Whether an already-loaded batch (resident preload OR matched scan) still
   * satisfies a (possibly changed) memory cap. A COMPLETE batch (it captured all
   * rows before hitting the cap) always does. A TRUNCATED batch (it filled up to
   * its cap, more rows exist) only does while the new cap doesn't ask for more
   * rows than it already holds — so lowering the cap never reloads/rescans, and
   * raising it past a truncated batch does, to fetch the extra rows.
   */
  private static batchAdequateForCap(result: PointsLoadResult, memoryCap: number): boolean {
    if (!result.preloadTruncated) {
      return true;
    }
    return (result.shape[1] ?? 0) >= memoryCap;
  }

  /**
   * Copy a resident batch keeping only its first `rows` points (file order),
   * marked truncated. Used to shed rows when the memory cap is LOWERED below what
   * is resident — so a 4M cap never keeps 8M rows around — without re-fetching.
   * Columnar geometry + per-row codes are sliced in lockstep.
   */
  private static sliceResidentBatch(data: PointsLoadResult, rows: number): PointsLoadResult {
    const sliceArray = (array: ArrayLike<number>): ArrayLike<number> => {
      const maybeSliceable = array as unknown as {
        slice?: (start: number, end: number) => ArrayLike<number>;
      };
      return typeof maybeSliceable.slice === 'function'
        ? maybeSliceable.slice(0, rows)
        : Array.prototype.slice.call(array, 0, rows);
    };
    const dims = data.shape[0] ?? data.data.length;
    return {
      ...data,
      shape: [dims, rows],
      data: data.data.map(sliceArray),
      ...(data.featureCodes ? { featureCodes: sliceArray(data.featureCodes) } : {}),
      preloadTruncated: true,
    };
  }

  /**
   * Ensure the selected features' points are available for rendering. The scan
   * loads the whole dataset for a selection (footer stats skip non-matching row
   * groups) and retains the per-row codes, so the render can **filter that batch
   * in the layer**. That makes a selection that is a SUBSET of an already-loaded
   * batch a free in-memory filter — removing a feature never re-scans (its rows
   * are already in memory), symmetric with resident filtering. A scan runs only
   * when the selection needs codes no loaded/in-flight batch covers. Settles →
   * `notify()`.
   */
  ensureMatchingFeaturesLoaded(
    target: PointsLoadTarget,
    featureCodes: readonly number[],
    memoryCap: number = DEFAULT_POINTS_MEMORY_CAP
  ): Promise<void> {
    const { key, element } = target;
    // there will be various mutating side-effects on entry as we progress...
    // so maybe that could include gradual accumulation of points,
    // pending a less side-effect/mutation-ridden approach.
    // we've been hitting a lot of general issues debugging this in general,
    // (not necessarily this particular point in the code) and the behaviour is not right.
    // I think I'm inclined to more purity. Might consider using Effect?
    // would be a much bigger future change.
    const entry = this.entries.get(key) ?? { status: 'idle' as PointsLoadStatus };
    this.entries.set(key, entry);
    const signature = PointsDataEngine.matchingSignature(featureCodes);
    const isCoveredBy = (sig: string): boolean => {
      const covered = PointsDataEngine.coveredCodes(sig);
      return featureCodes.every((code) => covered.has(code));
    };
    // A loaded batch already covers this selection AND still satisfies the memory
    // cap → reuse it, the layer filters down to the current codes. No scan. This
    // is both the removal fast path and the cap-lowering fast path: dropping the
    // cap (or any cap change where the loaded rows already suffice) never rescans.
    if (
      entry.matching &&
      isCoveredBy(entry.matching.signature) &&
      PointsDataEngine.batchAdequateForCap(entry.matching.result, memoryCap)
    ) {
      // Any in-flight scan for a different (now-unneeded) selection is superseded.
      entry.matchingLoading = undefined;
      return Promise.resolve();
    }
    // An in-flight scan will cover this selection once it settles (e.g. a feature
    // was removed mid-scan) → wait for it rather than starting another.
    if (entry.matchingLoading && isCoveredBy(entry.matchingLoading.signature)) {
      return entry.matchingLoading.promise;
    }

    // Notify at most every `PROGRESS_NOTIFY_STEP` matched rows so the panel's
    // partial stats update live without a re-render per scanned row group.
    // (not sure how important this is, may prefer to see more granular update)
    const PROGRESS_NOTIFY_STEP = 5_000;
    let lastNotifiedMatched = 0;
    const onProgress = (progress: PointsLoadProgress): void => {
      // I'm a bit iffy about this ambient stateful thing
      const loading = entry.matchingLoading;
      if (!loading || loading.signature !== signature) {
        return;
      }
      loading.matchedRows = progress.matchedRows;
      loading.scannedRows = progress.scannedRows;
      // we have a partialResult, which includes an accumulated buffer
      // probably prefer to have AsyncGenerator throughout rather than this
      // we're not doing the right thing yet, just seeing if we can push some data
      // and render... at very least needs cleaning up resources, etc etc
      loading.partialResult = progress.partialResult;
      if (progress.matchedRows - lastNotifiedMatched >= PROGRESS_NOTIFY_STEP) {
        lastNotifiedMatched = progress.matchedRows;
        this.notify(); // runs during the async scan, not render — safe to notify sync
      }
    };

    const promise = (async () => {
      try {
        // Dict-only elements have no file-backed code column, so the scan must
        // resolve each row's feature_name against the same catalog the selection
        // was made in. Pass that map; the core call ignores it for indexed
        // elements (which match on their code column instead).
        const featureCodeByName =
          entry.featureCodeColumn === true
            ? undefined
            : featureCodeMapFromCatalog(entry.catalog);
        //todo streamy version
        const result = await element.loadPointsMatchingFeatureCodes({
          featureCodes,
          memoryCap,
          onProgress,
          ...(featureCodeByName ? { featureCodeByName } : {}),
        });
        // Apply only if this is still the latest requested scan — a newer
        // selection may have superseded it while we were loading. Keeping the
        // previous `matching` batch until the current one is ready is what lets
        // the render keep showing the prior selection instead of blanking.
        if (entry.matchingLoading?.signature === signature) {
          entry.matching = { signature, result };
        }
      } catch (error) {
        console.error(`Failed feature-index scan for ${target.layerId}:`, error);
      } finally {
        if (entry.matchingLoading?.signature === signature) {
          entry.matchingLoading = undefined;
        }
        this.notify();
      }
    })();
    entry.matchingLoading = { signature, promise, matchedRows: 0, scannedRows: 0 };
    // Surface the loading transition, but DEFER it: this method is kicked from
    // `getLayers` *during* render, so a synchronous notify would setState mid-
    // render. A microtask runs after the current render commits.
    queueMicrotask(() => this.notify());
    return promise;
  }

  /**
   * Load-state snapshot for a selection's feature-index scan: whether it is in
   * flight, its progressive matched/scanned counts, and its final counts once
   * settled. Drives the panel's "loading … / N points" indicator. Returns
   * `undefined` when this selection has neither loaded nor started.
   */
  getMatchingLoadState(
    key: string,
    featureCodes: readonly number[]
  ): PointsMatchingLoadState | undefined {
    const entry = this.entries.get(key);
    const signature = PointsDataEngine.matchingSignature(featureCodes);
    if (entry?.matchingLoading?.signature === signature) {
      return {
        loading: true,
        matchedRows: entry.matchingLoading.matchedRows,
        scannedRows: entry.matchingLoading.scannedRows,
        settled: false,
      };
    }
    if (entry?.matching?.signature === signature) {
      const result = entry.matching.result;
      return {
        loading: false,
        matchedRows: result.shape[1] ?? 0,
        scannedRows: result.scannedRowCount ?? 0,
        settled: true,
      };
    }
    // The selection is a subset of an already-loaded batch (a removal reused it).
    // It is settled — the layer just filters the batch — so report it as loaded
    // rather than letting the indicator vanish. `covered` lets the panel word it
    // as "served from memory" since the count is the whole in-memory batch.
    if (entry?.matching && PointsDataEngine.coveredCodes(entry.matching.signature).size > 0) {
      const covered = PointsDataEngine.coveredCodes(entry.matching.signature);
      if (featureCodes.length > 0 && featureCodes.every((code) => covered.has(code))) {
        const result = entry.matching.result;
        return {
          loading: false,
          matchedRows: result.shape[1] ?? 0,
          scannedRows: result.scannedRowCount ?? 0,
          settled: true,
          covered: true,
        };
      }
    }
    return undefined;
  }

  /**
   * Feature codes of the **last completed** matched selection — i.e. the
   * non-resident features whose points are actually on screen right now (see
   * {@link getMatchingResource}, which keeps that batch during a new scan).
   *
   * The panel greys features that are neither resident nor rendered. Deriving
   * "rendered" from this last-completed set (not the current scan's settled
   * state) is what keeps already-loaded features un-greyed while a newly added
   * feature's scan is still in flight. `undefined` when nothing has settled.
   */
  getLoadedMatchingFeatureCodes(key: string): ReadonlySet<number> | undefined {
    const signature = this.entries.get(key)?.matching?.signature;
    if (signature === undefined) {
      return undefined;
    }
    return PointsDataEngine.coveredCodes(signature);
  }

  /**
   * Per-row feature codes of the last-completed matched batch, row-aligned with
   * {@link getMatchingResource}'s geometry. The render passes these to the layer
   * as `preloadedFeatureCodes` so it can filter the (possibly superset) matched
   * batch down to the current selection in memory — no re-scan on a removal.
   */
  getMatchingRowFeatureCodes(key: string): ArrayLike<number> | undefined {
    return this.entries.get(key)?.matching?.result.featureCodes;
  }

  /**
   * Stable render resource for the **last completed** matched selection, or null
   * if no selection has ever settled. Deliberately NOT keyed to the current
   * selection: while a new selection's scan is in flight, this keeps returning the
   * previous selection's batch so the render shows those points instead of
   * blanking for the (potentially multi-second) scan. 
   * 
   * The resource is cached on the matched batch and only changes identity when the 
   * batch does, so panning doesn't reset the composite. 
   * Pair with `getMatchingLoadState` (exact-signature)
   * for the "is the current selection loaded" question.
   */
  getMatchingResource(element: PointsElement, key: string): PointsRenderResource | null {
    const entry = this.entries.get(key);
    if (!entry?.matching) {
      return null;
    }
    // Empty-lock guard: a scan that matched no rows must NOT supersede the resident
    // preview — otherwise the render locks to an empty batch with no way to recover
    // (the settled selection never re-scans). Returning null falls back to resident
    // filtering. A legitimately empty selection can't reach here: an empty
    // `featureCodes` selection short-circuits before any scan is kicked.
    if ((entry.matching.result.shape[1] ?? 0) === 0) {
      return null;
    }
    if (entry.matching.resource) {
      return entry.matching.resource;
    }
    const cache = { preloaded: entry.matching.result, metadataKnown: false };
    const resource = resolvePointsRenderResource(element, cache, {
      experimentalOptimizations: 'off' as const,
    });
    if (resource) {
      entry.matching.resource = resource;
    }
    return resource;
  }

  /**
   * Render resource for the in-flight scan's latest `partialResult`, which the
   * producer builds as a GROWING buffer (every matched chunk accumulated so far),
   * so points progressively fill in before the full scan settles. Cached on the
   * partial's identity (rebuilds only when a new chunk grows the buffer, not per
   * pan). `null` when no scan is in flight / nothing has decoded yet / empty.
   */
  getMatchingPartialResource(element: PointsElement, key: string): PointsRenderResource | null {
    const loading = this.entries.get(key)?.matchingLoading;
    const partial = loading?.partialResult;
    if (!loading || !partial || (partial.shape[1] ?? 0) === 0) {
      return null;
    }
    if (loading.partialResource?.source === partial) {
      return loading.partialResource.resource;
    }
    const resource = resolvePointsRenderResource(
      element,
      { preloaded: partial, metadataKnown: false },
      { experimentalOptimizations: 'off' as const }
    );
    if (resource) {
      loading.partialResource = { source: partial, resource };
    }
    return resource;
  }

  /** Per-row feature codes of the in-flight scan's partial buffer, row-aligned
   * with {@link getMatchingPartialResource}. The render passes these as
   * `preloadedFeatureCodes` so the partial overlay can filter to the *current*
   * selection — otherwise a feature deselected mid-scan (whose scan is still
   * running because the smaller selection is covered) keeps rendering until the
   * scan settles. */
  getMatchingPartialRowFeatureCodes(key: string): ArrayLike<number> | undefined {
    return this.entries.get(key)?.matchingLoading?.partialResult?.featureCodes;
  }

  /** Whether the feature-index scan for this exact selection is in flight. */
  isMatchingLoading(key: string, featureCodes: readonly number[]): boolean {
    const entry = this.entries.get(key);
    return entry?.matchingLoading?.signature === PointsDataEngine.matchingSignature(featureCodes);
  }

  /** Whether the resident batch is in its final state for this cap — i.e. no
   * resident work is needed. False (work needed) when it must GROW (a truncated
   * batch and the cap was raised past it → reload) or SHRINK (it holds more rows
   * than the cap → shed the excess). So raising past a truncated batch reloads,
   * lowering below what's loaded sheds, and any cap a complete batch within the
   * cap already covers is a no-op. */
  isLoadedWithCap(key: string, memoryCap: number): boolean {
    const entry = this.entries.get(key);
    if (entry?.data === undefined) {
      return false;
    }
    return (
      PointsDataEngine.batchAdequateForCap(entry.data, memoryCap) &&
      (entry.data.shape[1] ?? 0) <= memoryCap
    );
  }

  /**
   * Truncation state of the resident preload — is it the whole dataset or only a
   * capped window, and how many rows of how many. `undefined` until data loads.
   * Surfaced so the user can see when raising the cap would show more points.
   */
  getResidentTruncation(
    key: string
  ): { truncated: boolean; loaded: number; total?: number } | undefined {
    const data = this.entries.get(key)?.data;
    if (!data) {
      return undefined;
    }
    return {
      truncated: data.preloadTruncated === true,
      loaded: data.shape[1] ?? 0,
      ...(data.totalRowCount !== undefined ? { total: data.totalRowCount } : {}),
    };
  }

  /**
   * Truncation state of what is actually on screen. With an active selection that
   * a scanned batch covers, that batch is the render — report ITS count and
   * whether it hit the cap (`filtered`), not the resident preload's, so the panel
   * doesn't keep saying "showing 4M" while a filtered subset is drawn. Otherwise
   * falls back to the resident preload. `undefined` until something has loaded.
   */
  getActiveTruncation(
    key: string,
    featureCodes: readonly number[] | undefined
  ): { truncated: boolean; loaded: number; total?: number; filtered?: boolean } | undefined {
    const entry = this.entries.get(key);
    if (!entry) {
      return undefined;
    }
    if (featureCodes && featureCodes.length > 0 && entry.matching) {
      const covered = PointsDataEngine.coveredCodes(entry.matching.signature);
      if (covered.size > 0 && featureCodes.every((code) => covered.has(code))) {
        const result = entry.matching.result;
        return {
          truncated: result.preloadTruncated === true,
          loaded: result.shape[1] ?? 0,
          filtered: true,
        };
      }
    }
    return this.getResidentTruncation(key);
  }

  /**
   * Idempotently preload an element's points at a given memory cap. A no-op when
   * the resident data already satisfies the cap (see {@link isLoadedWithCap}) —
   * so lowering the cap, or raising it when a complete batch already covers it,
   * never reloads. Only RAISING the cap past a *truncated* batch reloads, and it
   * keeps the previously-loaded data on screen until the larger batch settles
   * (an atomic swap — no blank). The full-dataset catalog and the matched
   * selection are preserved across the reload. Status via `onStatus`; notifies.
   */
  ensureLoaded(
    target: PointsLoadTarget,
    memoryCap: number = DEFAULT_POINTS_MEMORY_CAP
  ): Promise<void> {
    const { key, layerId, element } = target;
    const existing = this.entries.get(key);
    // (1) Existing data covers this cap without a reload (it is complete, or a
    // truncated batch the lowered cap doesn't outgrow).
    if (existing?.data !== undefined && PointsDataEngine.batchAdequateForCap(existing.data, memoryCap)) {
      // Cancel a now-unneeded in-flight load (e.g. the cap was raised then
      // lowered back to what we already hold).
      if (existing.loading) {
        existing.loadAbort?.abort();
        existing.loading = undefined;
        existing.loadAbort = undefined;
      }
      existing.memoryCap = memoryCap;
      // Cap lowered below what's resident → shed the excess in memory (no
      // re-fetch), so a 4M cap doesn't keep holding an 8M batch. Rebuild the
      // render resource / resident-code memos from the sliced batch.
      if ((existing.data.shape[1] ?? 0) > memoryCap) {
        existing.data = PointsDataEngine.sliceResidentBatch(existing.data, memoryCap);
        existing.resource = undefined;
        existing.residentCodes = undefined;
        existing.residentCodesSource = undefined;
        if (existing.rowCodes && existing.rowCodes.length > memoryCap) {
          existing.rowCodes = Array.prototype.slice.call(existing.rowCodes, 0, memoryCap);
        }
        this.notify();
      }
      return Promise.resolve();
    }
    // (2) A load for this exact cap is already in flight → dedup.
    if (existing?.loading && existing.memoryCap === memoryCap) {
      return existing.loading;
    }

    const entry: PointsEntry = existing ?? { status: 'idle' };
    // Reload needed (first load, or the cap was raised past a truncated batch).
    // Abort any superseded in-flight load, but KEEP the old resident data /
    // resource / row codes rendered — they are swapped atomically on completion,
    // so the view keeps showing what it had while the larger batch loads.
    entry.loadAbort?.abort();
    entry.memoryCap = memoryCap;
    const abort = new AbortController();
    entry.loadAbort = abort;
    entry.status = 'loading';
    this.entries.set(key, entry);
    this.callbacks.onStatus?.(layerId, 'loading');

    const loading = (async () => {
      try {
        // Read the feature column with the geometry so the filter's catalog and
        // per-row codes come from this one decode — no separate blocking load at
        // filter time. The catalog here reflects only the *resident* batch, so it
        // is an instant preview (`catalogLoaded`, not `catalogComplete`): the
        // full-dataset `ensureFeatureCatalog` scan is still allowed to run and
        // supersede it (a feature-ordered file's first part holds only a slice of
        // the features). Row codes are complete for the resident batch.
        const data = await element.loadPoints({
          includeFeatureCodes: true,
          memoryCap,
          signal: abort.signal,
        });
        // A newer cap may have superseded this load mid-flight; if so, drop it.
        if (abort.signal.aborted || entry.memoryCap !== memoryCap) {
          return;
        }
        // Atomic swap: replace the (possibly still-rendered) old batch and drop
        // the resource/resident-codes memos derived from it so they rebuild.
        entry.data = data;
        entry.resource = undefined;
        entry.residentCodes = undefined;
        entry.residentCodesSource = undefined;
        entry.status = 'ready';
        entry.featureCodeColumn = data.hasFeatureCodeColumn === true;
        if (data.featureCatalog !== undefined && !entry.catalogComplete) {
          entry.catalog = data.featureCatalog;
          entry.catalogLoaded = true;
        }
        if (data.featureCodes !== undefined) {
          entry.rowCodes = data.featureCodes;
          entry.rowCodesLoaded = true;
          // The preload derived these codes against its own catalog (the resident
          // preview, unless a full-dataset catalog already superseded it). Record
          // that space and reconcile to whatever catalog is current now.
          entry.rowCodesCatalog = data.featureCatalog;
          this.reconcileRowCodes(entry);
        }
        this.callbacks.onStatus?.(layerId, 'ready');
      } catch (error) {
        // Aborted (cap changed) or superseded → not a real error; stay quiet.
        if (abort.signal.aborted || entry.memoryCap !== memoryCap) {
          return;
        }
        entry.status = 'error';
        this.callbacks.onStatus?.(layerId, 'error');
        console.error(`Failed to load points for ${layerId}:`, error);
      } finally {
        // Only clear the in-flight markers if they are still ours (a superseding
        // cap change installs its own `loading`/`loadAbort`).
        if (entry.memoryCap === memoryCap) {
          entry.loading = undefined;
          entry.loadAbort = undefined;
        }
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
    const entry = this.entries.get(key);
    if (!entry || entry.catalogLoaded) {
      return false;
    }
    // The catalog rides the geometry preload (includeFeatureCodes), so a running
    // geometry load counts as the catalog loading too — the panel shows a
    // spinner rather than a premature "load feature list" prompt.
    return entry.catalogLoading !== undefined || entry.loading !== undefined;
  }

  /**
   * True while the full-dataset catalog scan is still running behind an instant
   * resident-subset preview. Lets the panel show a "loading the full feature
   * list" hint without hiding the preview it already has.
   */
  isFeatureCatalogRefining(key: string): boolean {
    const entry = this.entries.get(key);
    return (
      entry?.catalogLoaded === true &&
      entry.catalogComplete !== true &&
      entry.catalogLoading !== undefined
    );
  }

  /**
   * The distinct feature codes actually present in the resident batch (the
   * preload cap means a feature-ordered file only loads a slice of its features).
   * The panel greys features outside this set so selecting one that isn't loaded
   * — which would render no points — is understandable rather than a glitch.
   * Returns `undefined` when the row codes are not yet resident. Memoized against
   * the row-codes identity so the O(rows) scan runs once per batch.
   */
  /**
   * True when the element has a file-backed feature code column — a real feature
   * index whose codes are globally authoritative. False for dictionary-only
   * feature columns (codes app-assigned, only stable within one catalog build) or
   * an element with no feature codes. Undefined-safe: false until the resident
   * batch has loaded. Gates the whole-dataset feature-index scan.
   */
  hasFeatureCodeColumn(key: string): boolean {
    return this.entries.get(key)?.featureCodeColumn === true;
  }

  /**
   * Whether a whole-dataset feature scan can run for this element — i.e. reach
   * matching points beyond the resident preload window. True with a file-backed
   * code column (footer stats skip row groups), AND for dictionary-only elements
   * once a catalog is loaded: the scan resolves each row's `feature_name` against
   * that catalog's code space (no row-group skipping, so it reads the whole file,
   * but it retains every match up to the cap). False before any catalog loads —
   * dict-only codes are only stable relative to a catalog, so there'd be nothing
   * to match names against. Gates the render scan and the on-demand affordance.
   */
  supportsFeatureScan(key: string): boolean {
    const entry = this.entries.get(key);
    if (!entry) {
      return false;
    }
    return entry.featureCodeColumn === true || (entry.catalogLoaded === true && !!entry.catalog);
  }

  /**
   * Re-express {@link PointsEntry.rowCodes} in the current catalog's code space
   * when it was derived against an older one (resident preview → full-dataset
   * upgrade). No-op for authoritative file-backed codes (identical across builds)
   * and when the source/target catalogs are the same object. See
   * {@link remapRowFeatureCodes} for why dictionary-only codes need this.
   */
  private reconcileRowCodes(entry: PointsEntry): void {
    if (entry.featureCodeColumn === true) {
      return;
    }
    const source = entry.rowCodesCatalog;
    const target = entry.catalog;
    if (!entry.rowCodes || !source || !target || source === target) {
      return;
    }
    entry.rowCodes = remapRowFeatureCodes(entry.rowCodes, source, target);
    entry.rowCodesCatalog = target;
    // The distinct-codes memo was keyed to the old array identity — invalidate.
    entry.residentCodes = undefined;
    entry.residentCodesSource = undefined;
  }

  getResidentFeatureCodes(key: string): ReadonlySet<number> | undefined {
    const entry = this.entries.get(key);
    const rowCodes = entry?.rowCodes;
    if (!entry || rowCodes === undefined) {
      return undefined;
    }
    if (entry.residentCodes && entry.residentCodesSource === rowCodes) {
      return entry.residentCodes;
    }
    const set = new Set<number>();
    for (let i = 0; i < rowCodes.length; i += 1) {
      set.add(rowCodes[i]);
    }
    entry.residentCodes = set;
    entry.residentCodesSource = rowCodes;
    return set;
  }

  /**
   * Idempotently build the *full-dataset* feature catalog (feature-column scan;
   * worker-offloaded for oversized datasets). Uses `listFeaturesWithCounts` so the
   * panel can show/sort by per-feature counts. Runs even when a resident-subset
   * preview is already showing (`catalogLoaded` but not `catalogComplete`) and
   * supersedes it; no-op once the full scan has settled (`catalogComplete`) or is
   * in flight.
   */
  ensureFeatureCatalog(target: PointsLoadTarget): Promise<void> {
    const { key, element } = target;
    const entry = this.entries.get(key) ?? { status: 'idle' as PointsLoadStatus };
    this.entries.set(key, entry);
    if (entry.catalogComplete) {
      return Promise.resolve();
    }
    if (entry.catalogLoading) {
      return entry.catalogLoading;
    }

    const loading = (async () => {
      try {
        const fullCatalog = await element.listFeaturesWithCounts();
        entry.catalog = fullCatalog;
        // The full-dataset catalog is authoritative. Re-express any resident row
        // codes (derived against the resident-preview catalog) in its code space
        // so the render's per-row codes match the panel's selection + swatches.
        this.reconcileRowCodes(entry);
      } catch (error) {
        // Keep any resident preview catalog on failure rather than blanking it.
        if (!entry.catalogLoaded) entry.catalog = null;
        console.error(`Failed to build points feature catalog for ${target.layerId}:`, error);
      } finally {
        entry.catalogLoaded = true;
        entry.catalogComplete = true;
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
        const catalog = this.getFeatureCatalog(key);
        entry.rowCodes = await element.loadRowFeatureCodes({ featureCatalog: catalog });
        // These codes were derived against `catalog`; record that space so a later
        // catalog upgrade reconciles them (see reconcileRowCodes).
        entry.rowCodesCatalog = catalog ?? undefined;
        this.reconcileRowCodes(entry);
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
