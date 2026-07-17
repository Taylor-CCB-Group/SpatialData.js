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
 * All four resources — `preload`, `rowCodes`, `catalog`, `matching` — are
 * {@link RequestSlot}s: one tested dedup/supersede/settle primitive, keyed so that
 * everything a request depends on is in the key. Supersession is by record identity,
 * never value — a superseded load cannot write anything. The keys ARE the race fixes:
 * `preload`/`rowCodes` on the memory cap (R1, R5); `matching` on
 * `` `${signature}#${cap}` `` (R2 dedups a re-selected covered scan, R3 supersedes on
 * a cap raise). A failed slot holds a structured, **retryable** `SpatialEntryError`
 * that {@link retry} re-runs — which is what unsticks the previously-permanent
 * full-catalog-scan failure.
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
  /**
   * Feature catalog, two-phase, as a {@link RequestSlot} keyed `'preview' | 'full'`.
   * The resident-subset **preview** falls out of the geometry preload's decode
   * (`settle('preview', …)`); the authoritative **full** scan
   * (`listFeaturesWithCounts`) supersedes it (`request('full', …)`), retaining the
   * preview as `stale` so it keeps showing while the full list loads. A settled value
   * is the catalog, or `null` for an element with no `feature_key` — a fact, not an
   * absence. A failed full scan is `failed` + **retryable** (Track A step A4): it no
   * longer settles permanently, so {@link retry} can re-run it.
   */
  catalog: RequestSlot<CatalogPhase, PointsFeatureCatalog | null>;
  /** The catalog whose code space the {@link rowCodes} value is expressed in. */
  rowCodesCatalog?: PointsFeatureCatalog;
  /** True when the element has a file-backed feature code column (authoritative
   * codes; a real feature index). False for dictionary-only feature columns. */
  featureCodeColumn?: boolean;
  /** Memoized distinct codes in the resident {@link rowCodes}, invalidated by
   * identity. A DATA memo (a Set), not a render resource — it stays in core. */
  residentCodes?: ReadonlySet<number>;
  residentCodesSource?: ArrayLike<number>;
  /**
   * Whole-dataset points for the active selection — the feature-index scan — as a
   * {@link RequestSlot}. Keyed by `` `${signature}#${cap}` ``: the selected-codes
   * signature closes R2 (re-selecting a covered selection dedups to the live scan),
   * and the cap closes R3 (raising the cap supersedes rather than reusing the smaller
   * scan). The value carries its `signature` so coverage checks can read it, and the
   * streaming `partial` is the scan's growing buffer.
   */
  matching: RequestSlot<string, MatchingValue>;
}

/** A settled or in-flight matched batch, tagged with the selection it covers. */
interface MatchingValue {
  readonly signature: string;
  readonly result: PointsLoadResult;
}

/** The two catalog phases: the instant resident-subset preview, then the
 * authoritative full-dataset scan that supersedes it. */
type CatalogPhase = 'preview' | 'full';

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
        matching: new RequestSlot<string, MatchingValue>({
          context: {
            elementKey: key,
            kind: 'points',
            resource: 'matching',
            fallback: 'decode-failed',
          },
          onChange,
          // The scan reports progress and a growing partial the panel/overlay draw,
          // so its loading transitions and streamed partials ARE re-renders.
          notifyOnLoading: true,
        }),
        catalog: new RequestSlot<CatalogPhase, PointsFeatureCatalog | null>({
          context: {
            elementKey: key,
            kind: 'points',
            resource: 'catalog',
            fallback: 'decode-failed',
          },
          onChange,
          // The full-list scan shows a spinner; its loading transition is a re-render.
          notifyOnLoading: true,
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
    // Colour-by-feature is ON BY DEFAULT in the renderer (opt-out via
    // `colorByFeature: false`), so the per-row codes must load whenever colour is not
    // explicitly disabled — not only on an active selection. Gating on
    // `=== true` left the "all features" view (no selection, no explicit flag) with no
    // codes, so it drew flat. A dataset with a code column carries codes on the batch
    // regardless, but the dict-only fallback settles the codes through THIS task, so
    // the gate is what made dict-only "all features" render flat.
    const needsRowCodes = selectionActive || config.colorByFeature !== false;
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
    const slot = this.entries.get(key)?.catalog;
    if (!slot) return Resolution.idle();
    // The catalog rides the geometry preload, so surface a running preload as the
    // catalog loading too — a spinner, not an "idle" gap before the preview arrives.
    if (slot.resolution.status === 'idle' && this.entries.get(key)?.preload.isLoading) {
      return Resolution.loading();
    }
    return slot.resolution;
  }

  private rowCodesResolution(key: string): Resolution<ArrayLike<number> | undefined> {
    return this.entries.get(key)?.rowCodes.resolution ?? Resolution.idle();
  }

  private matchingResolution(key: string): Resolution<PointsLoadResult> {
    // Unwrap the slot's Resolution<MatchingValue> into Resolution<PointsLoadResult>
    // — the resource surface is the batch, the signature is internal bookkeeping.
    // Built on a snapshot-cache miss (once per version), so a fresh identity is fine.
    const slot = this.entries.get(key)?.matching;
    if (!slot) return Resolution.idle();
    const r = slot.resolution;
    switch (r.status) {
      case 'ready':
        return Resolution.ready(r.value.result);
      case 'loading':
        return Resolution.loading({
          ...(r.partial !== undefined ? { partial: r.partial.result } : {}),
          ...(r.stale !== undefined ? { stale: r.stale.result } : {}),
          ...(r.progress !== undefined ? { progress: r.progress } : {}),
        });
      case 'failed':
        return Resolution.failed(r.error, r.stale?.result);
      default:
        return Resolution.idle();
    }
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

  /** The last-good matched-selection batch (survives a new scan as `stale`). Input
   * to the adapter's matched memo. */
  getMatchedBatch(key: string): PointsLoadResult | undefined {
    return this.entries.get(key)?.matching.lastGood?.result;
  }

  /** The in-flight scan's growing buffer. Input to the adapter's partial memo. */
  getPartialBatch(key: string): PointsLoadResult | undefined {
    return this.entries.get(key)?.matching.partial?.result;
  }

  /**
   * The key (`${signature}#${cap}`) of the in-flight scan whose partial is streaming,
   * or `undefined` when no scan is loading. The Renderer Adapter uses it to tell a
   * *growing* partial (same scan, keep the resource identity, bump a revision) from a
   * *new* scan (fresh resource) — the D10 flash fix.
   */
  getPartialScanKey(key: string): string | undefined {
    const slot = this.entries.get(key)?.matching;
    return slot?.isLoading ? slot.pendingKey : undefined;
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

  /** The matching slot key — signature AND cap, so both R2 and R3 are decided by it. */
  private static matchingKey(signature: string, memoryCap: number): string {
    return `${signature}#${memoryCap}`;
  }

  /** Split a matching slot key back into its signature and cap. */
  private static parseMatchingKey(key: string): { signature: string; memoryCap: number } {
    const hash = key.lastIndexOf('#');
    return { signature: key.slice(0, hash), memoryCap: Number(key.slice(hash + 1)) };
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
    const matched = entry.matching.lastGood;
    if (featureCodes && featureCodes.length > 0 && matched) {
      const covered = PointsResolver.coveredCodes(matched.signature);
      if (covered.size > 0 && featureCodes.every((code) => covered.has(code))) {
        const result = matched.result;
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
      if (data.featureCatalog !== undefined && entry.catalog.settledKey !== 'full') {
        // Instant resident-subset preview; the full-dataset scan may supersede it.
        entry.catalog.settle('preview', data.featureCatalog);
      }
      if (data.featureCodes !== undefined) {
        // Row codes fall out of this decode, aligned to the batch at exactly this cap.
        entry.rowCodes.settle(memoryCap, data.featureCodes);
        entry.rowCodesCatalog = data.featureCatalog;
        this.reconcileRowCodes(entry, this.getFeatureCatalog(key));
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
    const slot = entry.matching;
    const signature = PointsResolver.matchingSignature(featureCodes);
    const isCoveredBy = (sig: string): boolean => {
      const covered = PointsResolver.coveredCodes(sig);
      return featureCodes.every((code) => covered.has(code));
    };

    // (1) A last-good batch already covers this selection AND still satisfies the
    //     cap → reuse it; the layer filters down in memory. No scan. Coverage is a
    //     subset relation, richer than the slot's exact-key dedup, so it stays here.
    const lastGood = slot.lastGood;
    if (
      lastGood &&
      isCoveredBy(lastGood.signature) &&
      PointsResolver.batchAdequateForCap(lastGood.result, memoryCap)
    ) {
      // A now-unneeded scan may be in flight (the selection just shrank) → cancel it
      // and keep the covering batch resident.
      if (slot.isLoading) {
        slot.settle(PointsResolver.matchingKey(lastGood.signature, memoryCap), lastGood);
      }
      return slot.pending ?? Promise.resolve();
    }

    // (2) An in-flight scan at this cap will cover this selection once it settles →
    //     wait for it. This is R2: re-selecting a covered selection mid-scan must not
    //     start a second scan corrupting the first.
    if (slot.isLoading && slot.pendingKey !== undefined) {
      const pending = PointsResolver.parseMatchingKey(slot.pendingKey);
      if (pending.memoryCap === memoryCap && isCoveredBy(pending.signature)) {
        return slot.pending ?? Promise.resolve();
      }
    }

    // (3) A new scan. The key carries the cap, so raising it supersedes rather than
    //     being served by the smaller scan (R3).
    const scanKey = PointsResolver.matchingKey(signature, memoryCap);
    const PROGRESS_NOTIFY_STEP = 5_000;
    let lastNotifiedMatched = 0;
    return slot.request(scanKey, async ({ emit, signal }) => {
      // Dict-only elements have no file-backed code column, so the scan must resolve
      // each row's feature_name against the same catalog the selection was made in.
      // The core call ignores this for indexed elements.
      const featureCodeByName =
        entry.featureCodeColumn === true
          ? undefined
          : featureCodeMapFromCatalog(this.getFeatureCatalog(key));
      const onProgress = (progress: PointsLoadProgress): void => {
        // Keep the partial buffer fresh on EVERY tick (its identity drives the
        // overlay resource), but only NOTIFY every PROGRESS_NOTIFY_STEP matched rows
        // — the render granularity the old engine used. `emit` is dropped by the slot
        // once this scan is superseded.
        const silent = progress.matchedRows - lastNotifiedMatched < PROGRESS_NOTIFY_STEP;
        if (!silent) {
          lastNotifiedMatched = progress.matchedRows;
        }
        emit(
          { signature, result: progress.partialResult },
          { done: progress.matchedRows, scanned: progress.scannedRows },
          { silent }
        );
      };
      const result = await element.loadPointsMatchingFeatureCodes({
        featureCodes,
        memoryCap,
        onProgress,
        signal, // superseded scan aborts between row-group chunks
        ...(featureCodeByName ? { featureCodeByName } : {}),
      });
      return { signature, result };
    });
  }

  /** Whether the feature-index scan for this exact selection is in flight. */
  isMatchingLoading(key: string, featureCodes: readonly number[]): boolean {
    const slot = this.entries.get(key)?.matching;
    if (!slot?.isLoading || slot.pendingKey === undefined) {
      return false;
    }
    return (
      PointsResolver.parseMatchingKey(slot.pendingKey).signature ===
      PointsResolver.matchingSignature(featureCodes)
    );
  }

  getMatchingLoadState(
    key: string,
    featureCodes: readonly number[]
  ): PointsMatchingLoadState | undefined {
    const slot = this.entries.get(key)?.matching;
    if (!slot) {
      return undefined;
    }
    const signature = PointsResolver.matchingSignature(featureCodes);

    // A scan for exactly this selection is in flight.
    if (slot.isLoading && slot.pendingKey !== undefined) {
      const pending = PointsResolver.parseMatchingKey(slot.pendingKey);
      if (pending.signature === signature) {
        const progress =
          slot.resolution.status === 'loading' ? slot.resolution.progress : undefined;
        return {
          loading: true,
          matchedRows: progress?.done ?? 0,
          scannedRows: progress?.scanned ?? 0,
          settled: false,
        };
      }
    }

    const matched = slot.lastGood;
    if (!matched) {
      return undefined;
    }
    const rows = matched.result.shape[1] ?? 0;
    if (matched.signature === signature) {
      return { loading: false, matchedRows: rows, scannedRows: rows, settled: true };
    }
    // A larger loaded batch covers this selection — served from memory, no scan.
    const covered = PointsResolver.coveredCodes(matched.signature);
    if (covered.size > 0 && featureCodes.every((code) => covered.has(code))) {
      return { loading: false, matchedRows: rows, scannedRows: rows, settled: true, covered: true };
    }
    return undefined;
  }

  /** The feature codes the last-good matched batch covers. */
  getLoadedMatchingFeatureCodes(key: string): ReadonlySet<number> | undefined {
    const matched = this.entries.get(key)?.matching.lastGood;
    if (!matched) {
      return undefined;
    }
    return PointsResolver.coveredCodes(matched.signature);
  }

  /** Per-row feature codes of the last-good matched batch, row-aligned with it. */
  getMatchingRowFeatureCodes(key: string): ArrayLike<number> | undefined {
    return this.entries.get(key)?.matching.lastGood?.result.featureCodes;
  }

  /** Per-row feature codes of the in-flight scan's partial buffer. */
  getMatchingPartialRowFeatureCodes(key: string): ArrayLike<number> | undefined {
    return this.entries.get(key)?.matching.partial?.result.featureCodes;
  }

  // --- Feature catalog --------------------------------------------------------

  getFeatureCatalog(key: string): PointsFeatureCatalog | null | undefined {
    const slot = this.entries.get(key)?.catalog;
    if (!slot) return undefined;
    // Settled (preview or full) → the value (a catalog, or null for no feature_key).
    if (slot.isReady) return slot.value ?? null;
    // Loading behind a preview, or a failed full-scan that retained one → keep
    // showing it. Not-yet-previewed / failed-with-nothing → undefined (not loaded).
    return slot.lastGood ?? undefined;
  }

  /** True while a settled catalog does not yet exist AND one is on its way (either
   * the full-list scan or the geometry preload that carries the preview). */
  isFeatureCatalogLoading(key: string): boolean {
    const entry = this.entries.get(key);
    if (!entry) return false;
    const slot = entry.catalog;
    // A settled preview or full catalog is "loaded"; the full scan behind a preview
    // is *refining*, not loading (see isFeatureCatalogRefining).
    if (slot.isReady || slot.lastGood !== undefined) return false;
    return slot.isLoading || entry.preload.isLoading;
  }

  /** True while the full-dataset scan runs behind an instant resident-subset preview. */
  isFeatureCatalogRefining(key: string): boolean {
    const slot = this.entries.get(key)?.catalog;
    return slot?.isLoading === true && slot.pendingKey === 'full' && slot.lastGood !== undefined;
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
    const catalog = this.getFeatureCatalog(key);
    return entry.featureCodeColumn === true || (catalog !== undefined && catalog !== null);
  }

  /**
   * Re-express `rowCodes` in a catalog's code space when they were derived against an
   * older one (resident preview → full-dataset upgrade). No-op for authoritative
   * file-backed codes, which are identical across builds. `target` is passed
   * explicitly because it may not yet be the settled catalog (the full scan calls
   * this with its result before returning it to its slot).
   */
  private reconcileRowCodes(
    entry: PointsEntry,
    target: PointsFeatureCatalog | null | undefined
  ): void {
    if (entry.featureCodeColumn === true) {
      return;
    }
    const source = entry.rowCodesCatalog;
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
    const slot = entry.catalog;
    // Already the authoritative full catalog, or a full scan already in flight → done.
    if (slot.settledKey === 'full') {
      return Promise.resolve();
    }
    if (slot.isLoading && slot.pendingKey === 'full') {
      return slot.pending ?? Promise.resolve();
    }
    // Request 'full' — supersedes any 'preview', retaining it as `stale` so the
    // preview keeps showing while the full list loads. A rejection becomes a
    // `failed` (retryable) resolution, NOT a permanent null-settle: that is what
    // A4's retry() unsticks. The preview, if any, survives as the failed `stale`.
    return slot.request('full', async () => {
      const fullCatalog = await element.listFeaturesWithCounts();
      // The full-dataset catalog is authoritative. Re-express any resident row codes
      // in its space so the render's per-row codes match the panel's selection.
      this.reconcileRowCodes(entry, fullCatalog);
      return fullCatalog;
    });
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
      const codes = await element.loadRowFeatureCodes({
        featureCatalog: catalog,
        memoryCap: cap,
        signal,
      });
      if (signal.aborted) return codes;
      // These codes were just built against `catalog`, so their code space IS the
      // current one — no remap here. A *later* catalog upgrade re-expresses them via
      // `ensureFeatureCatalog` → `reconcileRowCodes`, which reads the settled value.
      entry.rowCodesCatalog = catalog ?? undefined;
      return codes;
    });
  }

  // --- Retry ------------------------------------------------------------------

  /**
   * Re-run any **failed** resources of an element. This is what unsticks the
   * permanently-settled catalog scan (ADR 0004 §3): a failed full-catalog scan is a
   * `failed` slot, not a null-settle, so `retry()` re-runs its loader. Idle/loading/
   * ready slots are untouched. Returns once every retried load settles.
   */
  retry(key: string): Promise<void> {
    const entry = this.entries.get(key);
    if (!entry) return Promise.resolve();
    const pending = [entry.preload, entry.catalog, entry.rowCodes, entry.matching]
      .filter((slot) => slot.isFailed)
      .map((slot) => slot.retry())
      .filter((promise): promise is Promise<void> => promise !== undefined);
    return Promise.all(pending).then(() => undefined);
  }

  // --- Lifecycle --------------------------------------------------------------

  /** Drop an element from the cache. Catalog and row codes live in the same entry. */
  evict(key: string): void {
    const entry = this.entries.get(key);
    if (entry) {
      // Abort any in-flight load so a superseded/evicted scan stops decoding rather
      // than running to completion into a dropped result.
      entry.preload.reset();
      entry.rowCodes.reset();
      entry.catalog.reset();
      entry.matching.reset();
    }
    const existed = this.entries.delete(key);
    this.snapshots.evictByElement(key);
    // Notify so external-store consumers drop the now-stale snapshot immediately,
    // rather than showing it until the next unrelated mutation.
    if (existed) this.notify();
  }

  dispose(): void {
    for (const entry of this.entries.values()) {
      entry.preload.reset();
      entry.rowCodes.reset();
      entry.catalog.reset();
      entry.matching.reset();
    }
    this.entries.clear();
    this.snapshots.clear();
    this.listeners.clear();
  }
}
