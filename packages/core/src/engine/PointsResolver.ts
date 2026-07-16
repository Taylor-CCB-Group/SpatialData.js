import type { PointsElement } from '../models/index.js';
import { featureCodeMapFromCatalog, remapRowFeatureCodes } from '../pointsFeatures.js';
import { DEFAULT_POINTS_MEMORY_CAP } from '../pointsLimits.js';
import type { PointsLoadProgress, PointsLoadResult } from '../pointsLoadOptions.js';
import type { PointsFeatureCatalog } from '../pointsTiling.js';
import type { EntryNotice } from './errors.js';
import { RequestSlot } from './RequestSlot.js';
import { Resolution } from './resolution.js';
import type { EntryResources, ResolveContext, ResolveTask, ResourceResolver } from './resolver.js';
import { SnapshotCache } from './snapshotCache.js';

/**
 * The points Resource Resolver.
 *
 * This is `PointsDataEngine`'s **cache and lifecycle half**, moved from
 * `@spatialdata/layers` to `@spatialdata/core` per ADR 0004 §1. It owns the
 * per-element resource lifecycle — the resident preload, the feature catalog, the
 * per-row feature codes, and the whole-dataset feature-index scan — including
 * their cache, request dedup, supersession, cancellation and streaming partials.
 *
 * ## What did NOT come with it, and why
 *
 * The three **render-resource memos** (`getResource`, `getMatchingResource`,
 * `getMatchingPartialResource`) stayed behind, in `layers`, as
 * `PointsRendererAdapter`. Identity-stable memoisation is a *deck* requirement —
 * deck tears a layer down and rebuilds its batch when `data` identity changes — so
 * ADR 0004 §4 puts it on the renderer side. The memo was not deleted; it was
 * *rescheduled*, from lazily-on-first-getter-call to eagerly-once in `project()`.
 *
 * What this resolver exposes instead is the memos' **inputs, by identity**:
 * {@link getData}, {@link getMatchedBatch}, {@link getPartialBatch}. Batches here
 * are always *replaced*, never mutated in place, so object identity is an exact
 * invalidation key. That matters: `pointsRenderResourceSignature` keys on row
 * *count*, not identity, which is precisely why the old engine had to manually
 * null `entry.resource` on every swap. The adapter keys on identity and needs no
 * such bookkeeping.
 *
 * ## Alignment invariant (load-bearing)
 *
 * `getRowFeatureCodes(key)` is row-aligned with the resident batch from
 * `ensureLoaded`. Both the geometry preload (`element.loadPoints()`) and the row
 * codes (`element.loadRowFeatureCodes()`) read the first `min(rowCount, memoryCap)`
 * rows in *file order*, so index i in the codes array names the feature of point i
 * in the batch.
 *
 * **The memory cap reaches both calls identically** — that is what keeps the mask
 * aligned. The `preload` and `rowCodes` slots are both keyed on the memory cap, and
 * `ensureRowFeatureCodes` reads the codes at the preload's cap (its slot key). This
 * closes race R5 (Track A): the old `ensureRowFeatureCodes` took no cap and fell back
 * to the 4M default while `ensureLoaded` honoured the user's, misaligning the mask
 * against an 8M resident batch.
 *
 * ## State model (Track A)
 *
 * Each entry's `preload` and `rowCodes` are {@link RequestSlot}s: one tested
 * dedup/supersede/settle primitive, keyed so that everything a request depends on is
 * in the key. Supersession is by record identity, never value — a superseded load
 * cannot write anything, which is what closes R1. (`catalog` and `matching` are
 * slotified in step A3.)
 */

export type PointsLoadStatus = 'idle' | 'loading' | 'ready' | 'error';

export interface PointsLoadTarget {
  /** Stable element key — the cache/resolver key. */
  key: string;
  /** Layer id, used only to report status back to the host. */
  layerId: string;
  element: PointsElement;
}

export interface PointsResolverCallbacks {
  /** Report load-status transitions so the host can drive its load-state UI. */
  onStatus?: (layerId: string, status: PointsLoadStatus) => void;
}

/** The serialisable points props this resolver plans against. */
export interface PointsResolveConfig {
  pointsMemoryCap?: number;
  colorByFeature?: boolean;
  featureCodes?: number[];
}

interface PointsEntry {
  /**
   * Resident geometry preload, keyed by memory cap. The key IS the cap: a cap
   * change supersedes (reload), an identical cap dedups, and a lowered cap is served
   * by an in-memory shed (`settle`) rather than a fetch. Record-identity
   * supersession is what closes R1 (a superseded reload can no longer wipe the live
   * one's markers). Its `stale` retention is the atomic swap — the previous batch
   * stays on screen until the larger one settles.
   */
  preload: RequestSlot<number, PointsLoadResult>;
  /**
   * Per-row feature codes aligned to the resident batch (see class doc), **keyed by
   * memory cap**. Keying on the cap is the R5 fix: the codes are read at the same
   * window as the geometry, so index i in the codes names the feature of point i in
   * the batch. `V` is `ArrayLike<number> | undefined` because an element with no
   * codes settles `ready(undefined)` — a settled fact, not an absence.
   */
  rowCodes: RequestSlot<number, ArrayLike<number> | undefined>;
  /** Feature catalog: `undefined` while unloaded, `null` once settled for an
   * element with no `feature_key`, else the catalog. `catalogLoaded` disambiguates
   * "not yet requested" from "settled as null". (Slotified in Track A step A3.) */
  catalog?: PointsFeatureCatalog | null;
  catalogLoaded?: boolean;
  catalogLoading?: Promise<void>;
  /** True once the full-dataset catalog scan (`listFeaturesWithCounts`) has
   * replaced any resident-subset preview. */
  catalogComplete?: boolean;
  /** The catalog whose code space the {@link rowCodes} value is expressed in. */
  rowCodesCatalog?: PointsFeatureCatalog;
  /** True when the element has a file-backed feature code column (authoritative
   * codes; a real feature index). False for dictionary-only feature columns. */
  featureCodeColumn?: boolean;
  /** Memoized distinct codes in the resident {@link rowCodes}, invalidated by
   * identity. A DATA memo (a Set), not a render resource — it stays in core. */
  residentCodes?: ReadonlySet<number>;
  residentCodesSource?: ArrayLike<number>;
  /** Whole-dataset points for the active selection, keyed by the selected-codes
   * `signature` so a selection change rebuilds it. (Slotified in step A3.) */
  matching?: { signature: string; result: PointsLoadResult };
  /** In-flight feature-index scan, with progressive counts from `onProgress`. */
  matchingLoading?: {
    signature: string;
    promise: Promise<void>;
    matchedRows: number;
    scannedRows: number;
    partialResult?: PointsLoadResult;
  };
}

/** Public snapshot of a selection's feature-index load, for the filter panel. */
export interface PointsMatchingLoadState {
  loading: boolean;
  matchedRows: number;
  scannedRows: number;
  settled: boolean;
  /** The selection is served by filtering a larger in-memory batch (no scan ran). */
  covered?: boolean;
}

export class PointsResolver implements ResourceResolver<PointsResolveConfig, PointsElement> {
  readonly kind = 'points' as const;
  /** Only the resident preload gates a first paint. The catalog, row codes and
   * feature scan all refine an already-drawable layer. */
  readonly blockingResources = ['preload'] as const;

  private readonly entries = new Map<string, PointsEntry>();
  private readonly listeners = new Set<() => void>();
  private readonly callbacks: PointsResolverCallbacks;
  private readonly snapshots = new SnapshotCache();
  private version = 0;

  constructor(callbacks: PointsResolverCallbacks = {}) {
    this.callbacks = callbacks;
  }

  /** Get the entry for `key`, creating it (with its slots) on first touch. */
  private ensureEntry(key: string): PointsEntry {
    let entry = this.entries.get(key);
    if (!entry) {
      const onChange = () => this.notify();
      entry = {
        preload: new RequestSlot<number, PointsLoadResult>({
          context: {
            elementKey: key,
            kind: 'points',
            resource: 'preload',
            fallback: 'load-failed',
          },
          onChange,
          // The resident batch stays on screen through a reload (stale retention),
          // so only its settle is a re-render — matching the pre-slot notify count.
          notifyOnLoading: false,
        }),
        rowCodes: new RequestSlot<number, ArrayLike<number> | undefined>({
          context: {
            elementKey: key,
            kind: 'points',
            resource: 'rowCodes',
            fallback: 'decode-failed',
          },
          onChange,
          notifyOnLoading: false,
        }),
      };
      this.entries.set(key, entry);
    }
    return entry;
  }

  // --- ResourceResolver -------------------------------------------------------

  /**
   * PURE, SYNC. What does this entry need? Starts nothing.
   *
   * These three conditions are exactly the ones the old code evaluated — but two
   * of them were evaluated *inside `getLayers()`, during React render*, and kicked
   * their loads with a bare `void engine.ensureX(...)`. They were always pure
   * functions of config plus entry state; they were just being asked in the wrong
   * phase. Here they cannot start work even by accident.
   */
  plan(ctx: ResolveContext<PointsResolveConfig, PointsElement>): readonly ResolveTask[] {
    const { elementKey: key, config } = ctx;
    const tasks: ResolveTask[] = [];
    const cap = config.pointsMemoryCap ?? DEFAULT_POINTS_MEMORY_CAP;

    if (!this.isLoadedWithCap(key, cap)) {
      // The cap IS in the id: a cap change must supersede, not dedup. (R3 is the
      // matching path making exactly this mistake.)
      tasks.push({ id: `${key}#preload:${cap}`, resource: 'preload', payload: { memoryCap: cap } });
    }

    const selection = config.featureCodes;
    const selectionActive = selection !== undefined && selection.length > 0;

    // Was `void engine.ensureRowFeatureCodes(...)` at useLayerData.ts:1425.
    const needsRowCodes = selectionActive || config.colorByFeature === true;
    if (needsRowCodes && !this.hasRowFeatureCodes(key)) {
      tasks.push({ id: `${key}#rowCodes`, resource: 'rowCodes' });
    }

    // Was `void engine.ensureMatchingFeaturesLoaded(...)` at useLayerData.ts:1375.
    if (selectionActive && this.supportsFeatureScan(key)) {
      const signature = PointsResolver.matchingSignature(selection);
      tasks.push({
        id: `${key}#matching:${signature}:${cap}`,
        resource: 'matching',
        payload: { featureCodes: selection, memoryCap: cap },
      });
    }

    return tasks;
  }

  /** ASYNC. The only place I/O starts. Dispatches to the lifecycle methods below. */
  async load(
    task: ResolveTask,
    ctx: ResolveContext<PointsResolveConfig, PointsElement>,
    _signal: AbortSignal
  ): Promise<void> {
    const target: PointsLoadTarget = {
      key: ctx.elementKey,
      layerId: ctx.entryId,
      element: ctx.element,
    };
    const payload = task.payload as
      | { memoryCap?: number; featureCodes?: readonly number[] }
      | undefined;
    const cap = payload?.memoryCap ?? DEFAULT_POINTS_MEMORY_CAP;

    switch (task.resource) {
      case 'preload':
        await this.ensureLoaded(target, cap);
        return;
      case 'catalog':
        await this.ensureFeatureCatalog(target);
        return;
      case 'rowCodes':
        await this.ensureRowFeatureCodes(target);
        return;
      case 'matching':
        await this.ensureMatchingFeaturesLoaded(target, payload?.featureCodes ?? [], cap);
        return;
      default:
        return;
    }
  }

  /**
   * PURE, SYNC. Identity-stable between mutations — an adapter memoises against
   * it, so a fresh object per call would be a deck teardown per frame.
   */
  snapshot(ctx: ResolveContext<PointsResolveConfig, PointsElement>): EntryResources {
    const key = ctx.elementKey;
    // Key the memo by everything the snapshot embeds: the entry (several layers
    // may share one element), and the selection (it drives the truncation notice).
    // Points bounds are not wired in Step 1, so the transform is not part of the key.
    const configSig = (ctx.config.featureCodes ?? []).join(',');
    const cached = this.snapshots.get(ctx.entryId, this.version, ctx.transform, configSig);
    if (cached) return cached;

    const value: EntryResources = {
      entryId: ctx.entryId,
      elementKey: key,
      resources: {
        preload: this.preloadResolution(key),
        catalog: this.catalogResolution(key),
        rowCodes: this.rowCodesResolution(key),
        matching: this.matchingResolution(key),
      },
      notices: this.notices(key, ctx.config.featureCodes),
      bounds: null, // Points bounds come from the tiling metadata; not wired in Step 1.
      revision: this.version,
    };

    this.snapshots.set(ctx.entryId, this.version, ctx.transform, configSig, value);
    return value;
  }

  private preloadResolution(key: string): Resolution<PointsLoadResult> {
    // The slot IS the resolution — built at mutation time, returned by identity.
    // A `loading` carries the previous batch as `stale` (the atomic swap, no blank);
    // a rejected load is now a structured `failed` (Track A wired the error through).
    return this.entries.get(key)?.preload.resolution ?? Resolution.idle();
  }

  private catalogResolution(key: string): Resolution<PointsFeatureCatalog | null> {
    const entry = this.entries.get(key);
    if (!entry) return Resolution.idle();
    if (entry.catalogLoaded) return Resolution.ready(entry.catalog ?? null);
    return this.isFeatureCatalogLoading(key) ? Resolution.loading() : Resolution.idle();
  }

  private rowCodesResolution(key: string): Resolution<ArrayLike<number> | undefined> {
    return this.entries.get(key)?.rowCodes.resolution ?? Resolution.idle();
  }

  private matchingResolution(key: string): Resolution<PointsLoadResult> {
    const entry = this.entries.get(key);
    if (!entry) return Resolution.idle();
    const loading = entry.matchingLoading;
    if (loading) {
      return Resolution.loading({
        ...(loading.partialResult !== undefined ? { partial: loading.partialResult } : {}),
        ...(entry.matching !== undefined ? { stale: entry.matching.result } : {}),
        progress: { done: loading.matchedRows, scanned: loading.scannedRows },
      });
    }
    return entry.matching ? Resolution.ready(entry.matching.result) : Resolution.idle();
  }

  private notices(key: string, featureCodes: readonly number[] | undefined): EntryNotice[] {
    const out: EntryNotice[] = [];
    const truncation = this.getActiveTruncation(key, featureCodes);
    if (truncation?.truncated && truncation.total !== undefined) {
      out.push({
        kind: 'preload-truncated',
        message: `Showing ${truncation.loaded.toLocaleString()} of ${truncation.total.toLocaleString()} points`,
        loaded: truncation.loaded,
        total: truncation.total,
      });
    }
    if (this.isFeatureCatalogRefining(key)) {
      out.push({
        kind: 'catalog-is-resident-preview',
        message: 'Loading the full feature list…',
      });
    }
    return out;
  }

  // --- Subscription -----------------------------------------------------------

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  getVersion(): number {
    return this.version;
  }

  private notify(): void {
    this.version += 1;
    for (const listener of this.listeners) {
      listener();
    }
  }

  // --- Reads ------------------------------------------------------------------

  hasData(key: string): boolean {
    return this.entries.get(key)?.preload.lastGood !== undefined;
  }

  /** The resident preload batch. One of the three inputs the Renderer Adapter memoises. */
  getData(key: string): PointsLoadResult | undefined {
    // `lastGood`, not `value`: through a cap-raise reload the previous batch is
    // retained as `stale` and stays the drawable resident batch until the new one settles.
    return this.entries.get(key)?.preload.lastGood;
  }

  /** The settled matched-selection batch. Input to the adapter's matched memo. */
  getMatchedBatch(key: string): PointsLoadResult | undefined {
    return this.entries.get(key)?.matching?.result;
  }

  /** The in-flight scan's growing buffer. Input to the adapter's partial memo. */
  getPartialBatch(key: string): PointsLoadResult | undefined {
    return this.entries.get(key)?.matchingLoading?.partialResult;
  }

  getStatus(key: string): PointsLoadStatus {
    const resolution = this.entries.get(key)?.preload.resolution;
    switch (resolution?.status) {
      case 'loading':
        return 'loading';
      case 'ready':
        return 'ready';
      case 'failed':
        return 'error';
      default:
        return 'idle';
    }
  }

  /** Order-independent cache key for a selected-codes set. */
  private static matchingSignature(featureCodes: readonly number[]): string {
    return [...featureCodes].sort((left, right) => left - right).join(',');
  }

  /** Feature codes a matched batch/scan covers, parsed from its signature. */
  private static coveredCodes(signature: string): Set<number> {
    if (signature === '') {
      return new Set();
    }
    return new Set(signature.split(',').map(Number));
  }

  /**
   * Whether an already-loaded batch still satisfies a (possibly changed) memory
   * cap. A COMPLETE batch always does. A TRUNCATED batch only does while the new
   * cap doesn't ask for more rows than it already holds — so lowering never
   * reloads, and raising past a truncated batch does.
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
   *
   * `preloadTruncated: true` is load-bearing, not decoration: it is what tells
   * `batchAdequateForCap` that raising the cap again must re-fetch. Drop it and a
   * shed batch reads as complete, so the rows never come back.
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

  /** Whether the resident batch is in its final state for this cap. */
  isLoadedWithCap(key: string, memoryCap: number): boolean {
    const data = this.entries.get(key)?.preload.lastGood;
    if (data === undefined) {
      return false;
    }
    return PointsResolver.batchAdequateForCap(data, memoryCap) && (data.shape[1] ?? 0) <= memoryCap;
  }

  getResidentTruncation(
    key: string
  ): { truncated: boolean; loaded: number; total?: number } | undefined {
    const data = this.entries.get(key)?.preload.lastGood;
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
   * Truncation state of what is actually on screen. With an active selection a
   * scanned batch covers, that batch IS the render — report its count, not the
   * resident preload's, or the panel keeps saying "showing 4M" over a filtered subset.
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
      const covered = PointsResolver.coveredCodes(entry.matching.signature);
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

  // --- Resident preload -------------------------------------------------------

  /**
   * Idempotently preload an element's points at a given memory cap. A no-op when
   * the resident data already satisfies the cap. Only RAISING the cap past a
   * *truncated* batch reloads, and the previous batch stays on screen until the
   * larger one settles (an atomic swap — no blank).
   */
  ensureLoaded(
    target: PointsLoadTarget,
    memoryCap: number = DEFAULT_POINTS_MEMORY_CAP
  ): Promise<void> {
    const { key, layerId, element } = target;
    const entry = this.ensureEntry(key);
    const slot = entry.preload;
    const resident = slot.lastGood;

    // (1) The resident batch already covers this cap — no reload.
    if (resident !== undefined && PointsResolver.batchAdequateForCap(resident, memoryCap)) {
      if ((resident.shape[1] ?? 0) > memoryCap) {
        // Cap lowered below what's resident → shed the excess IN MEMORY (no re-fetch),
        // to a new key so a later raise supersedes. `settle` also cancels any
        // in-flight reload for a different cap.
        slot.settle(memoryCap, PointsResolver.sliceResidentBatch(resident, memoryCap));
        entry.residentCodes = undefined;
        entry.residentCodesSource = undefined;
        const codes = entry.rowCodes.value;
        if (codes && codes.length > memoryCap) {
          entry.rowCodes.settle(memoryCap, Array.prototype.slice.call(codes, 0, memoryCap));
        }
      } else if (slot.isLoading) {
        // Resident already adequate but a reload for another cap is running → cancel
        // it and keep the resident batch.
        slot.settle(memoryCap, resident);
      }
      return slot.pending ?? Promise.resolve();
    }

    // (2)(3) Reload at this cap. The slot dedups an identical in-flight request and
    // supersedes one for a different cap (R1: a superseded reload cannot write the
    // live one's state). The previous batch stays on screen as `stale` until the new
    // one settles — the atomic swap.
    const before = slot.pending;
    const loading = slot.request(memoryCap, async ({ signal }) => {
      // Read the feature column with the geometry so the filter's catalog and per-row
      // codes come from this one decode. The catalog here reflects only the *resident*
      // batch — an instant preview the full-dataset scan may still supersede.
      const data = await element.loadPoints({ includeFeatureCodes: true, memoryCap, signal });
      // Superseded mid-flight (a newer cap won): drop the derived cross-slot writes
      // and let the slot ignore the return. Writing catalog/row codes from a stale
      // load is exactly the corruption R1/R5 were.
      if (signal.aborted) return data;
      entry.residentCodes = undefined;
      entry.residentCodesSource = undefined;
      entry.featureCodeColumn = data.hasFeatureCodeColumn === true;
      if (data.featureCatalog !== undefined && !entry.catalogComplete) {
        entry.catalog = data.featureCatalog;
        entry.catalogLoaded = true;
      }
      if (data.featureCodes !== undefined) {
        // Row codes fall out of this decode, aligned to the batch at exactly this cap.
        entry.rowCodes.settle(memoryCap, data.featureCodes);
        entry.rowCodesCatalog = data.featureCatalog;
        this.reconcileRowCodes(entry);
      }
      return data;
    });

    // Mirror the old onStatus contract precisely: 'loading' when a NEW load starts
    // (not on dedup), then 'ready'/'error' for the load that actually settles this
    // cap. A superseded or aborted load reports nothing.
    if (loading !== before) {
      this.callbacks.onStatus?.(layerId, 'loading');
      void loading.then(() => {
        if (slot.isReady && Object.is(slot.settledKey, memoryCap)) {
          this.callbacks.onStatus?.(layerId, 'ready');
        } else if (slot.isFailed) {
          this.callbacks.onStatus?.(layerId, 'error');
        }
      });
    }
    return loading;
  }

  // --- Feature-index scan (whole-dataset load of a selection) ------------------

  ensureMatchingFeaturesLoaded(
    target: PointsLoadTarget,
    featureCodes: readonly number[],
    memoryCap: number = DEFAULT_POINTS_MEMORY_CAP
  ): Promise<void> {
    const { key, element } = target;
    const entry = this.ensureEntry(key);
    const signature = PointsResolver.matchingSignature(featureCodes);
    const isCoveredBy = (sig: string): boolean => {
      const covered = PointsResolver.coveredCodes(sig);
      return featureCodes.every((code) => covered.has(code));
    };
    // A loaded batch already covers this selection AND still satisfies the cap →
    // reuse it; the layer filters down. No scan.
    if (
      entry.matching &&
      isCoveredBy(entry.matching.signature) &&
      PointsResolver.batchAdequateForCap(entry.matching.result, memoryCap)
    ) {
      entry.matchingLoading = undefined;
      return Promise.resolve();
    }
    // An in-flight scan will cover this selection once it settles → wait for it.
    if (entry.matchingLoading && isCoveredBy(entry.matchingLoading.signature)) {
      return entry.matchingLoading.promise;
    }

    const PROGRESS_NOTIFY_STEP = 5_000;
    let lastNotifiedMatched = 0;
    const onProgress = (progress: PointsLoadProgress): void => {
      const loading = entry.matchingLoading;
      if (!loading || loading.signature !== signature) {
        return;
      }
      loading.matchedRows = progress.matchedRows;
      loading.scannedRows = progress.scannedRows;
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
        // was made in. The core call ignores this for indexed elements.
        const featureCodeByName =
          entry.featureCodeColumn === true ? undefined : featureCodeMapFromCatalog(entry.catalog);
        const result = await element.loadPointsMatchingFeatureCodes({
          featureCodes,
          memoryCap,
          onProgress,
          ...(featureCodeByName ? { featureCodeByName } : {}),
        });
        // Apply only if this is still the latest requested scan. Keeping the
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
    // No queueMicrotask here, and none needed: nothing kicks a scan from render
    // any more. `plan()` is pure and returns a task; the store calls `load()` from
    // a commit-phase effect. The old engine's `queueMicrotask(() => this.notify())`
    // existed solely to defend against a synchronous notify during render, and the
    // phase separation makes that unreachable by construction.
    this.notify();
    return promise;
  }

  /** Whether the feature-index scan for this exact selection is in flight. */
  isMatchingLoading(key: string, featureCodes: readonly number[]): boolean {
    const entry = this.entries.get(key);
    return entry?.matchingLoading?.signature === PointsResolver.matchingSignature(featureCodes);
  }

  getMatchingLoadState(
    key: string,
    featureCodes: readonly number[]
  ): PointsMatchingLoadState | undefined {
    const entry = this.entries.get(key);
    if (!entry) {
      return undefined;
    }
    const signature = PointsResolver.matchingSignature(featureCodes);
    const loading = entry.matchingLoading;
    if (loading?.signature === signature) {
      return {
        loading: true,
        matchedRows: loading.matchedRows,
        scannedRows: loading.scannedRows,
        settled: false,
      };
    }
    const matching = entry.matching;
    if (!matching) {
      return undefined;
    }
    if (matching.signature === signature) {
      return {
        loading: false,
        matchedRows: matching.result.shape[1] ?? 0,
        scannedRows: matching.result.shape[1] ?? 0,
        settled: true,
      };
    }
    // A larger loaded batch covers this selection — served from memory, no scan.
    const covered = PointsResolver.coveredCodes(matching.signature);
    if (covered.size > 0 && featureCodes.every((code) => covered.has(code))) {
      return {
        loading: false,
        matchedRows: matching.result.shape[1] ?? 0,
        scannedRows: matching.result.shape[1] ?? 0,
        settled: true,
        covered: true,
      };
    }
    return undefined;
  }

  /** The feature codes the settled matched batch covers. */
  getLoadedMatchingFeatureCodes(key: string): ReadonlySet<number> | undefined {
    const matching = this.entries.get(key)?.matching;
    if (!matching) {
      return undefined;
    }
    return PointsResolver.coveredCodes(matching.signature);
  }

  /** Per-row feature codes of the settled matched batch, row-aligned with it. */
  getMatchingRowFeatureCodes(key: string): ArrayLike<number> | undefined {
    return this.entries.get(key)?.matching?.result.featureCodes;
  }

  /** Per-row feature codes of the in-flight scan's partial buffer. */
  getMatchingPartialRowFeatureCodes(key: string): ArrayLike<number> | undefined {
    return this.entries.get(key)?.matchingLoading?.partialResult?.featureCodes;
  }

  // --- Feature catalog --------------------------------------------------------

  getFeatureCatalog(key: string): PointsFeatureCatalog | null | undefined {
    const entry = this.entries.get(key);
    return entry?.catalogLoaded ? (entry.catalog ?? null) : undefined;
  }

  isFeatureCatalogLoading(key: string): boolean {
    const entry = this.entries.get(key);
    if (!entry || entry.catalogLoaded) {
      return false;
    }
    // The catalog rides the geometry preload, so a running geometry load counts as
    // the catalog loading too — a spinner, not a premature "load feature list" prompt.
    return entry.catalogLoading !== undefined || entry.preload.isLoading;
  }

  /** True while the full-dataset scan runs behind an instant resident-subset preview. */
  isFeatureCatalogRefining(key: string): boolean {
    const entry = this.entries.get(key);
    return (
      entry?.catalogLoaded === true &&
      entry.catalogComplete !== true &&
      entry.catalogLoading !== undefined
    );
  }

  /** True when the element has a file-backed feature code column (globally authoritative). */
  hasFeatureCodeColumn(key: string): boolean {
    return this.entries.get(key)?.featureCodeColumn === true;
  }

  /**
   * Whether a whole-dataset feature scan can run — i.e. reach matching points
   * beyond the resident preload window. True with a file-backed code column, AND
   * for dictionary-only elements once a catalog is loaded (the scan resolves each
   * row's `feature_name` against that catalog's code space).
   */
  supportsFeatureScan(key: string): boolean {
    const entry = this.entries.get(key);
    if (!entry) {
      return false;
    }
    return entry.featureCodeColumn === true || (entry.catalogLoaded === true && !!entry.catalog);
  }

  /**
   * Re-express `rowCodes` in the current catalog's code space when it was derived
   * against an older one (resident preview → full-dataset upgrade). No-op for
   * authoritative file-backed codes, which are identical across builds.
   */
  private reconcileRowCodes(entry: PointsEntry): void {
    if (entry.featureCodeColumn === true) {
      return;
    }
    const source = entry.rowCodesCatalog;
    const target = entry.catalog;
    const codes = entry.rowCodes.value;
    if (codes === undefined || !source || !target || source === target) {
      return;
    }
    // Re-express the resident codes in-place under the same cap key — the row window
    // is unchanged, only the code space is.
    const cap = entry.rowCodes.settledKey ?? DEFAULT_POINTS_MEMORY_CAP;
    entry.rowCodes.settle(cap, remapRowFeatureCodes(codes, source, target));
    entry.rowCodesCatalog = target;
    entry.residentCodes = undefined;
    entry.residentCodesSource = undefined;
  }

  /**
   * The distinct feature codes present in the resident batch. The panel greys
   * features outside this set, so selecting one that isn't loaded — which would
   * render no points — is understandable rather than a glitch.
   */
  getResidentFeatureCodes(key: string): ReadonlySet<number> | undefined {
    const entry = this.entries.get(key);
    const rowCodes = entry?.rowCodes.value;
    if (!entry || rowCodes === undefined) {
      return undefined;
    }
    if (entry.residentCodes && entry.residentCodesSource === rowCodes) {
      return entry.residentCodes;
    }
    const set = new Set<number>();
    for (let i = 0; i < rowCodes.length; i += 1) {
      set.add(rowCodes[i] as number);
    }
    entry.residentCodes = set;
    entry.residentCodesSource = rowCodes;
    return set;
  }

  /**
   * Idempotently build the *full-dataset* feature catalog. Runs even when a
   * resident-subset preview is showing, and supersedes it.
   */
  ensureFeatureCatalog(target: PointsLoadTarget): Promise<void> {
    const { key, element } = target;
    const entry = this.ensureEntry(key);
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
        // codes in its code space so the render's per-row codes match the panel's
        // selection and swatches.
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

  // --- Row feature codes ------------------------------------------------------

  getRowFeatureCodes(key: string): ArrayLike<number> | undefined {
    return this.entries.get(key)?.rowCodes.value;
  }

  /** True once row codes have settled (even if the element has none). */
  hasRowFeatureCodes(key: string): boolean {
    return this.entries.get(key)?.rowCodes.isReady === true;
  }

  /**
   * Idempotently load the row feature codes for the resident batch.
   *
   * **R5 fix:** the codes are read at the resident preload's cap — its slot key — so
   * index i in the codes names the feature of point i in the batch. Reading them at a
   * different window (the old 4M default while the preload honoured an 8M cap) is
   * exactly the mask misalignment R5 was. Normally the codes fall out of the geometry
   * decode (`ensureLoaded`) and this is a no-op; it is the fallback for a codeless
   * preload or a filter toggled before the codes were resident.
   */
  ensureRowFeatureCodes(target: PointsLoadTarget): Promise<void> {
    const { key, element } = target;
    const entry = this.ensureEntry(key);
    const slot = entry.rowCodes;
    const cap = entry.preload.settledKey ?? entry.preload.pendingKey ?? DEFAULT_POINTS_MEMORY_CAP;
    // Already aligned at this cap (typically settled by the preload decode) → no-op.
    if (slot.isReady && Object.is(slot.settledKey, cap)) {
      return slot.pending ?? Promise.resolve();
    }
    return slot.request(cap, async ({ signal }) => {
      const catalog = this.getFeatureCatalog(key);
      const codes = await element.loadRowFeatureCodes({ featureCatalog: catalog, memoryCap: cap });
      if (signal.aborted) return codes;
      // These codes were just built against `catalog`, so their code space IS the
      // current one — no remap here. A *later* catalog upgrade re-expresses them via
      // `ensureFeatureCatalog` → `reconcileRowCodes`, which reads the settled value.
      entry.rowCodesCatalog = catalog ?? undefined;
      return codes;
    });
  }

  // --- Lifecycle --------------------------------------------------------------

  /** Drop an element from the cache. Catalog and row codes live in the same entry. */
  evict(key: string): void {
    const existed = this.entries.delete(key);
    this.snapshots.evictByElement(key);
    // Notify so external-store consumers drop the now-stale snapshot immediately,
    // rather than showing it until the next unrelated mutation.
    if (existed) this.notify();
  }

  dispose(): void {
    this.entries.clear();
    this.snapshots.clear();
    this.listeners.clear();
  }
}
