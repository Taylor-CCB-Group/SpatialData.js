import type { Matrix4 } from '@math.gl/core';
import type { PointsElement } from '../models/index.js';
import { featureCodeMapFromCatalog, remapRowFeatureCodes } from '../pointsFeatures.js';
import { DEFAULT_POINTS_MEMORY_CAP } from '../pointsLimits.js';
import type { PointsLoadProgress, PointsLoadResult } from '../pointsLoadOptions.js';
import { planPointsLoads } from '../pointsLoadPlan.js';
import type { PointsFeatureCatalog, PointsTilingMetadata } from '../pointsTiling.js';
import { type AxisAlignedBounds, transformAxisAlignedBounds } from '../spatialViewFit.js';
import type { EntryNotice, SpatialEntryError } from './errors.js';
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
 * Keying the slot only makes the misalignment *representable*; {@link plan} is what
 * acts on it. It gates on {@link hasRowFeatureCodesAtCap}, not on readiness — codes
 * settled at 4M stay "ready" through a raise to 8M, so a readiness gate leaves a
 * stale mask in place over the bigger batch and R5 survives in the one place that
 * decides whether to fix it.
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
  /**
   * Whether to probe for a Morton-tiled artifact before falling back to the resident
   * preload (D5). `'auto'` probes; `'off'` (the default) never does, which is exactly
   * today's behaviour.
   *
   * Deliberately still opt-in at step 1: the probe DEFERS the preload until it
   * answers, and nothing yet renders a tiled element — see
   * `docs/plans/points-morton-tiled-viewport-loading.md` steps 2 and 5.
   */
  pointsTiling?: 'auto' | 'off';
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
  /**
   * The resident-subset preview from the last geometry decode, held OUTSIDE the
   * slot so it can be offered as a fallback without cancelling anything.
   *
   * `settle` aborts the in-flight request, so settling a preview on top of a
   * running full scan destroys it. Keeping the preview here lets
   * {@link PointsResolver.getFeatureCatalog} still show it instantly while the scan
   * runs (or after one fails), which is the whole point of the preview, without the
   * write that killed the scan.
   */
  previewCatalog?: PointsFeatureCatalog;
  /** True when the element has a file-backed feature code column (authoritative
   * codes; a real feature index). False for dictionary-only feature columns. */
  featureCodeColumn?: boolean;
  /** Memoized distinct codes in the resident {@link rowCodes}, invalidated by
   * identity. A DATA memo (a Set), not a render resource — it stays in core. */
  residentCodes?: ReadonlySet<number>;
  residentCodesSource?: ArrayLike<number>;
  /** Memoized per-code tally of the resident {@link rowCodes}, invalidated by the
   * same identity. Shares `residentCodesSource` — both are derived from one array. */
  residentCounts?: ReadonlyMap<number, number>;
  /**
   * Whole-dataset points for the active selection — the feature-index scan — as a
   * {@link RequestSlot}. Keyed by `` `${signature}#${cap}` ``: the selected-codes
   * signature closes R2 (re-selecting a covered selection dedups to the live scan),
   * and the cap closes R3 (raising the cap supersedes rather than reusing the smaller
   * scan). The value carries its `signature` so coverage checks can read it, and the
   * streaming `partial` is the scan's growing buffer.
   */
  matching: RequestSlot<string, MatchingValue>;
  /**
   * Morton tiling metadata (D5), as a one-key slot — the element path is fixed, so
   * there is exactly one request to make (`'probe'`).
   *
   * The value is **tileable metadata or `null`**, not raw metadata: the probe applies
   * the same renderability gate the render resolver would
   * (`supportsRowGroupRangeReads && bounds`), so `null` is the settled fact "this
   * element cannot be tiled" rather than "we have not looked". A *failed* probe reads
   * as `null` too — it must fall through to the preload rather than strand the layer —
   * while staying `failed`, and therefore retryable, in the snapshot.
   */
  tiling: RequestSlot<TilingProbeKey, PointsTilingMetadata | null>;
  /** World bounds of a tiled entry, memoised on the metadata AND the transform it
   * was computed with — bounds are transform-relative. */
  bounds?: AxisAlignedBounds | null;
  boundsSource?: PointsTilingMetadata;
  boundsTransform?: unknown;
}

/** The tiling slot's only key. The element path is fixed, so one request exists. */
type TilingProbeKey = 'probe';

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
  /**
   * The scan that would have loaded this selection failed.
   *
   * Reported because the alternative is worse than an error: the render path falls
   * back to filtering the resident batch, so a failed scan still draws *something* —
   * whichever subset of the selection happened to be inside the memory cap — and a
   * panel with no failure signal presents that partial view as the whole answer.
   * `error.retryable` gates a retry affordance; `PointsResolver.retry(key)` re-runs it.
   */
  failed?: true;
  error?: SpatialEntryError;
}

export class PointsResolver implements ResourceResolver<PointsResolveConfig, PointsElement> {
  readonly kind = 'points' as const;
  /**
   * What gates a first paint: the tiling probe (until it answers, we do not know
   * which path this entry is even on) and the resident preload. The catalog, row
   * codes and feature scan all refine an already-drawable layer.
   *
   * This stays a constant — *the snapshot varies instead*. `isBlocking` skips a
   * resource the entry does not have, so a tiled entry (which never plans a preload)
   * simply omits `preload` from its resources, and an entry with tiling off omits
   * `tiling`. That keeps the list what ADR 0004 asks for — data describing this
   * resolver's kind — rather than a switch, and avoids the alternative of settling a
   * fake `preload` resolution that lies about a load nobody ran.
   *
   * Getting this wrong is not cosmetic: a tiled entry whose `preload` stayed `idle`
   * blocks forever, and auto-fit rides the `isBlocking` true→false transition.
   */
  readonly blockingResources = ['tiling', 'preload'] as const;

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
        tiling: new RequestSlot<TilingProbeKey, PointsTilingMetadata | null>({
          context: {
            elementKey: key,
            kind: 'points',
            resource: 'tiling',
            fallback: 'load-failed',
          },
          onChange,
          // Nothing is drawable from a probe, so its start is not a re-render. Its
          // SETTLE still notifies (a settle always does), which is what re-plans —
          // and re-planning is how the deferred preload gets scheduled.
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

    // D5: probe for a Morton artifact BEFORE committing to a full-table preload, and
    // preload only once the probe has answered "not tileable". The two decisions are
    // one function (`planPointsLoads`, shared with the pre-decomposition wiring) so
    // they cannot drift apart into the state that preloads a table it is about to
    // tile. With `pointsTiling` off (the default) `probeMetadata` is false and
    // `preloadFullTable` collapses to `!hasPreloaded` — today's gate exactly.
    const { probeMetadata, preloadFullTable } = planPointsLoads({
      wantsOptimized: config.pointsTiling === 'auto',
      metadataKnown: this.isTilingSettled(key),
      tiledMetadata: this.getTilingMetadata(key),
      hasPreloaded: this.isLoadedWithCap(key, cap),
    });

    if (probeMetadata) {
      tasks.push({ id: `${key}#tiling`, resource: 'tiling' });
    }
    if (preloadFullTable) {
      // The cap IS in the id: a cap change must supersede, not dedup. (R3 is the
      // matching path making exactly this mistake.)
      tasks.push({ id: `${key}#preload:${cap}`, resource: 'preload', payload: { memoryCap: cap } });
    }

    // Row codes and the feature-index scan are both defined against the RESIDENT
    // batch — codes align to it row-for-row, and the scan exists only because the
    // resident window truncates the dataset. So they wait on the same question the
    // preload does, and for the same reason: a tiled element has no resident batch,
    // making the row-codes read an expensive read of rows in file order that nothing
    // indexes into. Per-tile codes and tiled filtering are step 4 of the D5 plan.
    //
    // Gating on the PENDING probe too, not just on `isTiled`, is what makes the
    // deferral real: planning them while the probe is in flight both does the wasted
    // read AND settles the codes, so the check on the next pass reads "already
    // loaded" and the work is invisible from then on.
    if (probeMetadata || this.isTiledFor(config, key)) {
      return tasks;
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
    // Codes are only a valid mask for the batch they were read at THE SAME CAP as
    // (R5) — index i names point i only then. `isReady` does not say that: codes
    // settled at 4M stay ready after a raise to 8M, so this gate never re-requested
    // them and the mask silently addressed the wrong rows against the bigger batch.
    // Ask at the cap they would actually be loaded at, and put it in the task id so
    // a cap change re-dispatches instead of deduping.
    const rowCodesCap = this.rowCodesCap(key);
    // While a preload is in flight, hold off: its decode settles the codes at its
    // own cap for free whenever the element carries a code column, and asking now
    // would race a second full read of the feature column against it. If it settles
    // WITHOUT codes (the dict-only fallback), the next plan pass sees them
    // misaligned and asks then. A first load — no codes at all — never waits.
    const preloadInFlight = this.entries.get(key)?.preload.isLoading === true;
    const deferToPreload = this.hasRowFeatureCodes(key) && preloadInFlight;
    if (needsRowCodes && !this.hasRowFeatureCodesAtCap(key, rowCodesCap) && !deferToPreload) {
      tasks.push({ id: `${key}#rowCodes:${rowCodesCap}`, resource: 'rowCodes' });
    }

    // Was `void engine.ensureMatchingFeaturesLoaded(...)` at useLayerData.ts:1375.
    //
    // Only worth scanning when the resident batch might be MISSING matching rows.
    // A complete (untruncated) preload already holds every row in the dataset, so
    // the render path's in-memory filter returns exactly what a whole-dataset scan
    // would — instantly, with no I/O. Scanning anyway re-read the entire file and
    // showed "Loading selected features… 0 points so far" for a selection whose
    // points were already in memory.
    if (selectionActive && this.supportsFeatureScan(key) && !this.isResidentComplete(key)) {
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
      case 'tiling':
        await this.ensureTilingMetadata(target);
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
    // Key the memo by everything the snapshot embeds: the entry (several layers may
    // share one element), the selection (it drives the truncation notice), and
    // whether tiling is on (it decides which resources the entry even has, and a
    // config flip alone bumps no version).
    const configSig = `${(ctx.config.featureCodes ?? []).join(',')}|${ctx.config.pointsTiling ?? 'off'}`;
    const cached = this.snapshots.get(ctx.entryId, this.version, ctx.transform, configSig);
    if (cached) return cached;

    // Which resources this entry HAS — see `blockingResources`. A tiled entry has no
    // resident preload (not an idle one: none), and an entry with tiling off never
    // asked the tiling question.
    const tiled = this.isTiledFor(ctx.config, key);
    const resources: Record<string, Resolution<unknown>> = {
      catalog: this.catalogResolution(key),
      rowCodes: this.rowCodesResolution(key),
      matching: this.matchingResolution(key),
    };
    if (!tiled) {
      resources.preload = this.preloadResolution(key);
    }
    if (ctx.config.pointsTiling === 'auto') {
      resources.tiling = this.tilingResolution(key);
    }

    const value: EntryResources = {
      entryId: ctx.entryId,
      elementKey: key,
      resources,
      notices: this.notices(key, ctx.config.featureCodes),
      // A tiled entry can be framed from the artifact's own extent, with no geometry
      // in memory — which is the only thing that makes auto-fit possible before a
      // single tile has loaded. The preloaded path's bounds stay with the host (it
      // caches them against the resident batch); see the D5 plan step 2.
      bounds: tiled ? this.tiledBounds(key, ctx.transform) : null,
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

  private tilingResolution(key: string): Resolution<PointsTilingMetadata | null> {
    return this.entries.get(key)?.tiling.resolution ?? Resolution.idle();
  }

  /**
   * World bounds for a tiled entry, from the artifact's extent. Memoised on
   * (metadata, transform) like the shapes resolver memoises on (data, transform): the
   * snapshot returns bounds by identity, so recomputing per call would be a fresh
   * object every reconcile.
   */
  private tiledBounds(key: string, transform: Matrix4): AxisAlignedBounds | null {
    const entry = this.entries.get(key);
    const metadata = entry?.tiling.value;
    if (!entry || !metadata?.bounds) return null;
    if (entry.boundsSource === metadata && entry.boundsTransform === transform) {
      return entry.bounds ?? null;
    }
    const computed = transformAxisAlignedBounds(metadata.bounds, transform);
    entry.bounds = computed;
    entry.boundsSource = metadata;
    entry.boundsTransform = transform;
    return computed;
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

  /** Bump the version and re-run subscribers. Public so a facade holding derived
   * render state (e.g. the hover highlight in `PointsDataEngine`) can request a
   * repaint without a data mutation. */
  notify(): void {
    this.version += 1;
    for (const listener of this.listeners) {
      listener();
    }
  }

  // --- Reads ------------------------------------------------------------------

  hasData(key: string): boolean {
    return this.entries.get(key)?.preload.lastGood !== undefined;
  }

  // --- Tiling metadata (D5) ---------------------------------------------------

  /**
   * The element's **tileable** Morton metadata: the metadata when it can drive
   * viewport tiles, `null` when it cannot (including a failed probe — see
   * {@link PointsEntry.tiling}), and `undefined` while the question is still open.
   *
   * The three-way return is the point. `null` and `undefined` are what
   * {@link planPointsLoads} distinguishes to decide between "preload instead" and
   * "wait, we are still asking".
   */
  getTilingMetadata(key: string): PointsTilingMetadata | null | undefined {
    const slot = this.entries.get(key)?.tiling;
    if (!slot) return undefined;
    if (slot.isFailed) return null;
    return slot.value;
  }

  /**
   * Has the probe answered? True for a settled answer *and for a failed one* — a
   * failure is "we asked and cannot tile", not "ask again". Without that, a probe
   * that keeps failing would be re-planned on every reconcile forever, and the
   * preload it is standing in front of would never be scheduled. {@link retry} is
   * the deliberate way back.
   */
  isTilingSettled(key: string): boolean {
    const slot = this.entries.get(key)?.tiling;
    return slot !== undefined && (slot.isReady || slot.isFailed);
  }

  /**
   * Whether the ELEMENT has usable tiling metadata — a fact about the artifact, and
   * deliberately not the whole answer to "is this layer drawing tiles".
   *
   * The probe's answer is cached per element and survives `pointsTiling` being turned
   * back off, and two entries on one element may disagree about it. So a *consumer*
   * asking whether to take the tiled path must combine this with that entry's config —
   * see {@link isTiledFor}. Reading this alone is how a layer keeps rendering tiles
   * after the user switches tiling off.
   */
  isTiled(key: string): boolean {
    return this.getTilingMetadata(key) != null;
  }

  /** Whether THIS entry draws through the tile path: the element can be tiled, and
   * this entry asked for it. */
  private isTiledFor(config: PointsResolveConfig, key: string): boolean {
    return config.pointsTiling === 'auto' && this.isTiled(key);
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
   * The in-flight PRELOAD's growing geometry (D3) — what the base draws before the
   * first full window settles, so a cold load paints progressively instead of
   * staying blank. Undefined once the preload settles (`getData` takes over).
   */
  getPreloadPartialBatch(key: string): PointsLoadResult | undefined {
    return this.entries.get(key)?.preload.partial;
  }

  /**
   * Per-feature point counts for the resident batch (`code → rows`).
   *
   * Counts over the RESIDENT WINDOW, not the dataset — the authoritative totals come
   * from the catalog scan. Comparing the two is what tells a panel that a feature it
   * is drawing is only partly there: `resident` means "has at least one point inside
   * the memory cap", so on a truncated element every feature can be resident while
   * half the dataset is absent.
   *
   * Derived from the settled {@link rowCodes} in preference to the preload result's
   * own tally, because for a dictionary-only element the codes get re-expressed when
   * the full catalog supersedes the resident preview ({@link reconcileRowCodes}) and
   * the preload's frozen map is NOT remapped with them — it would keep answering in
   * the old code space, attributing one gene's count to another. The preload tally
   * remains the fallback: it streams, so the numbers climb while points arrive and
   * before row codes settle, and no remap can have happened yet at that point.
   */
  getResidentFeatureCounts(key: string): ReadonlyMap<number, number> | undefined {
    const entry = this.entries.get(key);
    if (!entry) {
      return undefined;
    }
    const rowCodes = entry.rowCodes.value;
    if (rowCodes !== undefined) {
      if (entry.residentCounts && entry.residentCodesSource === rowCodes) {
        return entry.residentCounts;
      }
      const counts = new Map<number, number>();
      for (let i = 0; i < rowCodes.length; i += 1) {
        const code = rowCodes[i] as number;
        counts.set(code, (counts.get(code) ?? 0) + 1);
      }
      entry.residentCounts = counts;
      entry.residentCodesSource = rowCodes;
      return counts;
    }
    return entry.preload.partial?.featureCodeCounts ?? entry.preload.lastGood?.featureCodeCounts;
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

  /**
   * Geometry status for the ELEMENT. The preload answers whenever it has anything to
   * say; the tiling probe answers only in the gap where it does not.
   *
   * That order matters because this is per element and tiling is per entry: an
   * element that some layer tiles may still be preloading for another layer that does
   * not, and the preload is the one with a real load in flight.
   */
  getStatus(key: string): PointsLoadStatus {
    const entry = this.entries.get(key);
    switch (entry?.preload.resolution.status) {
      case 'loading':
        return 'loading';
      case 'ready':
        return 'ready';
      case 'failed':
        return 'error';
      default:
        break;
    }
    // No preload activity. A tileable element is drawable as soon as the probe hands
    // over the artifact — individual tiles then load through deck's own `TileLayer`
    // lifecycle, which is not this status. While the probe runs, the entry IS loading
    // geometry; reporting 'idle' would tell the host nothing is happening for the
    // whole footer read.
    if (this.isTiled(key)) return 'ready';
    if (entry?.tiling.isLoading) return 'loading';
    return 'idle';
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

  /**
   * Whether the resident batch demonstrably holds EVERY row of the dataset.
   *
   * True only for a settled, untruncated preload — then any feature question can be
   * answered by filtering what is already in memory, and a whole-dataset scan is
   * pure waste. Deliberately false while the preload is still in flight or its
   * state is unknown, so this only ever removes provably-unnecessary work.
   */
  private isResidentComplete(key: string): boolean {
    const data = this.entries.get(key)?.preload.lastGood;
    return data !== undefined && data.preloadTruncated !== true;
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
        entry.residentCounts = undefined;
        entry.residentCodesSource = undefined;
        const codes = entry.rowCodes.value;
        // Deliberately conditional, and NOT re-keyed unconditionally on a shed.
        // Codes shorter than the new window are already misaligned, and re-keying
        // them to this cap would assert an alignment they do not have — the exact
        // lie the slot key exists to prevent. Leaving the key stale is what makes
        // the planning gate re-request them.
        //
        // `>` rather than `>=` is not a gap: codes are `min(rows, theirCap)` long, so
        // whenever their key differs from their length the resident batch is at most
        // that length too, and a shed below it makes the comparison strict anyway.
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
    // Repaint granularity for the progressive preload: emitting every row group would
    // re-render far more often than the eye needs on a multi-million-row load.
    const PRELOAD_NOTIFY_STEP = 250_000;
    let lastNotifiedRows = 0;
    const loading = slot.request(memoryCap, async ({ emit, signal }) => {
      // Read the feature column with the geometry so the filter's catalog and per-row
      // codes come from this one decode. The catalog here reflects only the *resident*
      // batch — an instant preview the full-dataset scan may still supersede.
      const data = await element.loadPoints({
        includeFeatureCodes: true,
        memoryCap,
        signal,
        // Progressive preload (D3): publish the growing geometry so the base layer
        // paints points as they decode instead of staying blank until the whole
        // window lands. `emit` is inert once this request is superseded.
        onProgress: (progress) => {
          const silent = progress.matchedRows - lastNotifiedRows < PRELOAD_NOTIFY_STEP;
          if (!silent) {
            lastNotifiedRows = progress.matchedRows;
          }
          emit(
            progress.partialResult,
            { done: progress.matchedRows, scanned: progress.scannedRows },
            { silent }
          );
        },
      });
      // Superseded mid-flight (a newer cap won): drop the derived cross-slot writes
      // and let the slot ignore the return. Writing catalog/row codes from a stale
      // load is exactly the corruption R1/R5 were.
      if (signal.aborted) return data;
      entry.residentCodes = undefined;
      entry.residentCounts = undefined;
      entry.residentCodesSource = undefined;
      entry.featureCodeColumn = data.hasFeatureCodeColumn === true;
      if (data.featureCatalog !== undefined) {
        entry.previewCatalog = data.featureCatalog;
        // Instant resident-subset preview; the full-dataset scan may supersede it.
        // But `settle` ABORTS whatever the slot is running, so writing the preview
        // while the full scan is in flight silently kills it — and nothing re-requests
        // a catalog (`plan()` never emits a catalog task; only the panel's mount effect
        // does), so the list stayed on partial "≥" counts until the panel remounted.
        // The preview is a strict downgrade of a scan already under way; it stays
        // available through `previewCatalog` instead.
        const fullPending = entry.catalog.isLoading && entry.catalog.pendingKey === 'full';
        if (entry.catalog.settledKey !== 'full' && !fullPending) {
          entry.catalog.settle('preview', data.featureCatalog);
        }
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

    // The scan that would have covered this selection failed. Checked BEFORE the
    // last-good branch: a failure retains the previous batch as `stale`, so reading
    // `lastGood` first would answer with a settled state for whatever was loaded
    // before — the panel would then report a healthy older selection while the one
    // the user is actually looking at silently never loaded.
    //
    // Coverage, not equality, for the same reason the reuse path uses it: a scan for
    // {A,B} that failed was going to supply {A} too, so shrinking the selection does
    // not make the failure irrelevant. A superseding scan for the smaller selection
    // moves the slot to `loading`, and the branch above wins.
    const failedKey = slot.failedKey;
    if (failedKey !== undefined && slot.resolution.status === 'failed') {
      const failed = PointsResolver.parseMatchingKey(failedKey);
      const wouldHaveCovered = PointsResolver.coveredCodes(failed.signature);
      if (
        failed.signature === signature ||
        (wouldHaveCovered.size > 0 && featureCodes.every((code) => wouldHaveCovered.has(code)))
      ) {
        return {
          loading: false,
          // Nothing landed for this selection; reporting the stale batch's row count
          // here is exactly the misreading this branch exists to prevent.
          matchedRows: 0,
          scannedRows: 0,
          settled: true,
          failed: true,
          error: slot.resolution.error,
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
    const entry = this.entries.get(key);
    const slot = entry?.catalog;
    if (!slot) return undefined;
    // Settled (preview or full) → the value (a catalog, or null for no feature_key).
    if (slot.isReady) return slot.value ?? null;
    // Loading: prefer the in-flight PARTIAL (the full names/codes list, published
    // before the slow counts scan) over an older preview — it is the more complete
    // list, just without counts yet. Then a preview, or a failed full-scan that
    // retained one; last, a preview the preload produced *underneath* a running scan,
    // which is deliberately not settled into the slot (see `previewCatalog`).
    // Nothing at all → undefined (not loaded).
    return slot.partial ?? slot.lastGood ?? entry?.previewCatalog ?? undefined;
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
    entry.residentCounts = undefined;
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
    return slot.request('full', async ({ emit, signal }) => {
      const fullCatalog = await element.listFeaturesWithCounts({
        // Publish the names-only catalog the moment it is known, so the panel can
        // list features (and colour them) while the per-feature counts scan — which
        // walks every row group — is still running. `emit` is inert once superseded.
        onPartialCatalog: (partial) => {
          emit(partial);
        },
      });
      // R1: a superseded load must not write anything, least of all CROSS-SLOT state.
      // The slot drops this return value, but `reconcileRowCodes` writes straight to
      // `entry.rowCodes` — and `listFeaturesWithCounts` takes no signal, so a
      // superseded scan runs to completion and lands here regardless. Remapping the
      // rows into a catalog nobody is showing is precisely the split that drew every
      // point in another gene's colour.
      if (signal.aborted) return fullCatalog;
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

  /** True once row codes have settled (even if the element has none). Says nothing
   * about WHICH cap they were read at — see {@link hasRowFeatureCodesAtCap}. */
  hasRowFeatureCodes(key: string): boolean {
    return this.entries.get(key)?.rowCodes.isReady === true;
  }

  /**
   * The cap {@link ensureRowFeatureCodes} would read the codes at — i.e. the
   * resident batch's window. Kept beside it so the planning gate and the loader
   * cannot disagree about which cap "aligned" means.
   */
  private rowCodesCap(key: string): number {
    const preload = this.entries.get(key)?.preload;
    return preload?.settledKey ?? preload?.pendingKey ?? DEFAULT_POINTS_MEMORY_CAP;
  }

  /** True once row codes have settled AT `memoryCap` — the only state in which they
   * are a valid row-aligned mask for the resident batch at that cap. */
  hasRowFeatureCodesAtCap(key: string, memoryCap: number): boolean {
    const slot = this.entries.get(key)?.rowCodes;
    return slot?.isReady === true && Object.is(slot.settledKey, memoryCap);
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

  // --- Tiling metadata probe (D5) ---------------------------------------------

  /**
   * Idempotently probe the element for a renderable Morton artifact.
   *
   * The renderability gate lives HERE, not at the render resolver: what this slot
   * settles is the answer to "can this element be tiled", so a Morton file whose
   * store cannot serve row-group range reads (or that carries no bounds) settles
   * `null` — the same conclusion `resolvePointsRenderResource`'s `canTile` reaches,
   * made once, where the planning decision that depends on it can see it.
   *
   * A probe that THROWS is not a dead end: the slot holds a retryable `failed`, and
   * {@link getTilingMetadata} reports `null` so the next plan pass schedules the
   * ordinary preload. That fallback arm is the one thing the pre-decomposition
   * wiring got right and is worth keeping exactly.
   */
  ensureTilingMetadata(target: PointsLoadTarget): Promise<void> {
    const { key, layerId, element } = target;
    const slot = this.ensureEntry(key).tiling;
    const before = slot.pending;
    const loading = slot.request('probe', async () => {
      const metadata = await element.getPointsTilingMetadata();
      if (!metadata?.supportsRowGroupRangeReads || !metadata.bounds) {
        return null;
      }
      return metadata;
    });

    // Same contract as the preload's: 'loading' only when a NEW request starts (not
    // on a dedup). The only terminal state the probe owns is a *tileable* answer —
    // that entry is now drawable. Every other outcome hands off to the preload, which
    // reports its own; claiming 'ready' here would clear the spinner while the real
    // geometry load had not started.
    if (loading !== before) {
      this.callbacks.onStatus?.(layerId, 'loading');
      void loading.then(() => {
        if (this.isTiled(key)) {
          this.releaseResidentBatch(key);
          this.callbacks.onStatus?.(layerId, 'ready');
        }
      });
    }
    return loading;
  }

  /**
   * Drop the resident window once an element is known to be tiled.
   *
   * A layer switched to tiling mid-session has usually already preloaded — up to the
   * full memory cap, tens of millions of rows the tile path will never read. Nothing
   * else releases it: `plan()` stops ASKING for a preload, which is not the same as
   * giving one back, so the memory stayed held and the panel went on reporting "4M of
   * 12.1M in memory — capped" over a render that has no cap.
   *
   * The row codes and the feature-index scan go with it: both are defined against
   * that window (codes are row-aligned to it, the scan exists only because it
   * truncates the dataset), so keeping them would leave state describing a batch that
   * no longer exists. The catalog stays — it describes the ELEMENT's features, and the
   * filter panel still wants it.
   *
   * Runs once, on the probe's settle. A layer that is NOT tiling can re-request the
   * preload on its next plan pass — an element read two ways pays for it once, rather
   * than ping-ponging, because nothing evicts again.
   */
  private releaseResidentBatch(key: string): void {
    const entry = this.entries.get(key);
    if (!entry || entry.preload.resolution.status === 'idle') {
      return;
    }
    entry.preload.reset();
    entry.rowCodes.reset();
    entry.matching.reset();
    // Every memo derived from the row codes goes with them — they all key on
    // `residentCodesSource`, so leaving one behind keeps a map alive for a batch that
    // no longer exists, which is the opposite of the point of releasing it.
    entry.residentCodes = undefined;
    entry.residentCounts = undefined;
    entry.residentCodesSource = undefined;
    this.notify();
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
    const pending = [entry.preload, entry.catalog, entry.rowCodes, entry.matching, entry.tiling]
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
      entry.tiling.reset();
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
      entry.tiling.reset();
    }
    this.entries.clear();
    this.snapshots.clear();
    this.listeners.clear();
  }
}
