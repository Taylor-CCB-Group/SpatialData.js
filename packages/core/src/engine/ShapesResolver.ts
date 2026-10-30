import type { ShapesElement } from '../models/index.js';
import type { ShapesRenderData } from '../shapes.js';
import {
  type AxisAlignedBounds,
  boundsFromCircles,
  boundsFromFlatPolygonPositions,
  boundsFromPolygons,
} from '../spatialViewFit.js';
import type { SpatialData } from '../store/index.js';
import {
  type AssociatedTableFeatureRows,
  loadAssociatedTableFeatureRows,
  tableRowsUnmatchedNotice,
} from '../tableAssociations.js';
import { loadShapesTooltipMetadata, type ShapesTooltipMetadata } from '../tooltip.js';
import type { EntryNotice } from './errors.js';
import { isCancellation, toSpatialEntryError } from './errors.js';
import { Resolution } from './resolution.js';
import type { EntryResources, ResolveContext, ResolveTask, ResourceResolver } from './resolver.js';
import { SnapshotCache } from './snapshotCache.js';

/**
 * The shapes Resource Resolver.
 *
 * Three resources, and — this is the point of `Resolution` being **per-resource**
 * rather than per-entry — they fail independently. A shapes entry whose tooltip
 * column is broken must still draw its geometry.
 *
 *  - `geometry`   — `element.loadRenderData()`. Refines the canvas; blocks nothing
 *                   (see `blockingResources`). The layer draws once it settles.
 *  - `tooltip`    — `loadShapesTooltipMetadata()`. Keyed by the tooltip-fields signature.
 *  - `fillColor`  — `loadAssociatedTableFeatureRows()`. Keyed by the column name.
 *
 * All three loaders already lived in `core`; only the orchestration was stranded in
 * a React hook. A failed load surfaces as a `SpatialEntryError`, which is what the
 * classifier is for, rather than a re-throw with a nicer message.
 *
 * ## What is deliberately NOT here
 *
 * The **fill colour itself**. `load()` fetches the table rows; turning rows into
 * RGBA is `buildShapeFillColorByFeatureId` in `layers`, and it stays there. That
 * is not a dependency dodge — it is the phase separation working: fetching rows is
 * I/O, and mapping a column through a palette is a pure projection *for a
 * renderer*. It belongs in `project()`, which `ShapesRendererAdapter` in `layers`
 * now owns. Same for `buildShapesPrebuiltData`.
 *
 * So this resolver's `fillColor` resource is the **rows**, not the colours.
 *
 * ## Known bug, preserved
 *
 * Tooltip metadata and fill-colour rows are cached per **element**, but requested per
 * **layer config** — `buildResolveContext` builds one context per layer. Two layers
 * over one element that differ in `tooltipFields`, or in
 * `fillColorByColumn.columnName`, therefore invalidate each other forever: a
 * ping-pong, after which `getFillColorRows` hands back whichever column landed last.
 *
 * Keying the projections by layer id (`ShapesRendererAdapter`'s caches, as
 * `shapePrebuiltData` and `shapeFillColorData` did before it) stops two layers sharing
 * one colour map, but it cannot help when the rows underneath are the wrong column's —
 * so the fill-colour half of this is not avoided either.
 * `LabelsResolver` in `vis` already has the shape of the fix: `fillColors` is keyed by
 * element *and* column, and `getFillColorRows(key, column)` takes the column. Its
 * tooltips are per element, so that half is shared.
 *
 * Step 1 is a re-housing, so the behaviour is preserved as-is. **Track B owns the
 * fix**, and it is on the punchlist.
 */

export interface ShapesResolveConfig {
  tooltipFields?: string[];
  fillColorByColumn?: { columnName: string; mode: string };
}

export interface ShapesResolverCallbacks {
  onStatus?: (layerId: string, resource: string, status: 'loading' | 'ready' | 'error') => void;
}

interface ShapesEntry {
  geometry: Resolution<ShapesRenderData>;
  tooltip: Resolution<ShapesTooltipMetadata>;
  fillColor: Resolution<AssociatedTableFeatureRows>;
  /** In-flight promises, keyed by task id — today's dedup, kept byte for byte. */
  inFlight: Map<string, Promise<void>>;
  /** The tooltip-fields signature `tooltip` was loaded for. */
  tooltipSignature?: string;
  /** The column name `fillColor` was loaded for. */
  fillColorColumn?: string;
  /** Set by `retry()`: `plan()` otherwise schedules geometry only while it is idle. */
  retryGeometry?: boolean;
  bounds?: AxisAlignedBounds | null;
  boundsSource?: ShapesRenderData;
  /** The transform `bounds` was computed with — world bounds are transform-relative. */
  boundsTransform?: unknown;
  /** Facts about the loaded geometry — today, only that no shape joins to its table. */
  notices: readonly EntryNotice[];
}

const NO_NOTICES: readonly EntryNotice[] = [];

const tooltipSignature = (fields: string[] | undefined): string => (fields ?? []).join('');

export class ShapesResolver implements ResourceResolver<ShapesResolveConfig, ShapesElement> {
  readonly kind = 'shapes' as const;
  /**
   * **Nothing blocks.** Shapes load non-blocking: geometry refines an
   * already-painted canvas rather than gating first paint, so a shapes-only view
   * shows immediately and the geometry pops in when it settles. (Tooltip and fill
   * colour never blocked either.) This is the whole point of the non-blocking
   * pass — `blockingResources` is empty *data*, not a kind-switch, so
   * `store.isBlocking` reports shapes as never-blocking with no special case.
   *
   * The wait is still visible: the resolver reports `geometry: 'loading'` via
   * `onStatus`, which drives the host's non-modal `isLoading` indicator — just
   * not the modal overlay.
   */
  readonly blockingResources = [] as const;

  private readonly entries = new Map<string, ShapesEntry>();
  private readonly listeners = new Set<() => void>();
  private readonly callbacks: ShapesResolverCallbacks;
  private readonly spatialData: SpatialData | undefined;
  private readonly snapshots = new SnapshotCache();
  private version = 0;

  constructor(options: { spatialData?: SpatialData; callbacks?: ShapesResolverCallbacks } = {}) {
    this.spatialData = options.spatialData;
    this.callbacks = options.callbacks ?? {};
  }

  private entry(key: string): ShapesEntry {
    let entry = this.entries.get(key);
    if (!entry) {
      entry = {
        geometry: Resolution.idle(),
        tooltip: Resolution.idle(),
        fillColor: Resolution.idle(),
        inFlight: new Map(),
        notices: NO_NOTICES,
      };
      this.entries.set(key, entry);
    }
    return entry;
  }

  // --- ResourceResolver -------------------------------------------------------

  /** PURE, SYNC. Starts nothing. */
  plan(ctx: ResolveContext<ShapesResolveConfig, ShapesElement>): readonly ResolveTask[] {
    const key = ctx.elementKey;
    const entry = this.entries.get(key);
    const tasks: ResolveTask[] = [];

    if (!entry || Resolution.isIdle(entry.geometry) || entry.retryGeometry) {
      tasks.push({ id: `${key}#geometry`, resource: 'geometry' });
    }

    const fields = ctx.config.tooltipFields;
    if (fields && fields.length > 0) {
      const signature = tooltipSignature(fields);
      if (!entry || entry.tooltipSignature !== signature) {
        // The signature is IN the id: changing the tooltip columns supersedes.
        tasks.push({
          id: `${key}#tooltip:${signature}`,
          resource: 'tooltip',
          payload: { tooltipFields: fields },
        });
      }
    }

    const column = ctx.config.fillColorByColumn?.columnName;
    if (column) {
      if (!entry || entry.fillColorColumn !== column) {
        tasks.push({
          id: `${key}#fillColor:${column}`,
          resource: 'fillColor',
          payload: { column },
        });
      }
    }

    return tasks;
  }

  /** ASYNC. The only place I/O starts. Never throws — failures become Resolutions. */
  async load(
    task: ResolveTask,
    ctx: ResolveContext<ShapesResolveConfig, ShapesElement>,
    signal: AbortSignal
  ): Promise<void> {
    const entry = this.entry(ctx.elementKey);
    // Same id ⇒ same request ⇒ dedup. (Today's in-flight-promise check, kept.)
    const existing = entry.inFlight.get(task.id);
    if (existing) return existing;

    const run = this.run(task, ctx, entry, signal).finally(() => {
      if (entry.inFlight.get(task.id) === run) entry.inFlight.delete(task.id);
    });
    entry.inFlight.set(task.id, run);
    return run;
  }

  private async run(
    task: ResolveTask,
    ctx: ResolveContext<ShapesResolveConfig, ShapesElement>,
    entry: ShapesEntry,
    _signal: AbortSignal
  ): Promise<void> {
    const key = ctx.elementKey;
    const slot = task.resource as 'geometry' | 'tooltip' | 'fillColor';
    if (slot !== 'geometry' && slot !== 'tooltip' && slot !== 'fillColor') return;

    // Capture the exact pre-load resolution. On cancellation we restore it — an
    // initial load that is aborted must fall back to `idle`, or `plan()` (which
    // only schedules idle geometry) never reschedules it and the entry hangs.
    const prior = entry[slot];
    if (slot === 'geometry') entry.retryGeometry = false;
    // Retain the last good value across the refine, so a reload keeps drawing.
    const stale = Resolution.lastGood(entry[slot] as Resolution<never>);
    entry[slot] = Resolution.loading(stale !== undefined ? { stale } : {}) as never;
    this.callbacks.onStatus?.(ctx.entryId, slot, 'loading');
    this.notify();

    try {
      switch (slot) {
        case 'geometry': {
          const renderData = await ctx.element.loadRenderData();
          entry.notices = await this.unmatchedTableNotices(key, renderData);
          entry.geometry = Resolution.ready(renderData);
          break;
        }
        case 'tooltip': {
          const fields = (task.payload as { tooltipFields: string[] }).tooltipFields;
          const metadata = await loadShapesTooltipMetadata(this.spatialData, ctx.element, fields);
          entry.tooltip = Resolution.ready(metadata);
          entry.tooltipSignature = tooltipSignature(fields);
          break;
        }
        case 'fillColor': {
          const column = (task.payload as { column: string }).column;
          const rows = await loadAssociatedTableFeatureRows({
            spatialData: this.spatialData,
            kind: 'shapes',
            key,
            extraColumnNames: [column],
          });
          entry.fillColor = Resolution.ready(rows);
          entry.fillColorColumn = column;
          break;
        }
      }
      this.callbacks.onStatus?.(ctx.entryId, slot, 'ready');
    } catch (cause) {
      // Cancellation is a non-event: an aborted load is not a domain failure, and
      // painting an error for one would be a visible regression. Restore the exact
      // pre-load resolution so a cancelled slot never hangs in `loading`.
      if (isCancellation(cause)) {
        entry[slot] = prior as never;
        return;
      }
      const error = toSpatialEntryError(cause, {
        elementKey: key,
        kind: 'shapes',
        resource: slot,
        // The SEAM knows what it was doing. A geometry decode that throws is a
        // decode failure; a tooltip/table read that throws is a load failure.
        fallback: slot === 'geometry' ? 'decode-failed' : 'load-failed',
      });
      entry[slot] = Resolution.failed(error, stale) as never;
      // Record what failed, not just what succeeded: `plan()` reschedules whenever
      // these differ from the config, and every settle triggers a reconcile, so
      // leaving them unset re-requests the failing read in a loop.
      if (slot === 'tooltip') {
        entry.tooltipSignature = tooltipSignature(
          (task.payload as { tooltipFields: string[] }).tooltipFields
        );
      } else if (slot === 'fillColor') {
        entry.fillColorColumn = (task.payload as { column: string }).column;
      }
      this.callbacks.onStatus?.(ctx.entryId, slot, 'error');
    } finally {
      this.notify();
    }
  }

  /** PURE, SYNC. Identity-stable between mutations. */
  snapshot(ctx: ResolveContext<ShapesResolveConfig, ShapesElement>): EntryResources {
    const key = ctx.elementKey;
    // Key the memo by the entry (layers may share an element) and the transform
    // (it moves the bounds). Shapes resources and notices don't depend on config,
    // so there is no config dimension here.
    const cached = this.snapshots.get(ctx.entryId, this.version, ctx.transform, '');
    if (cached) return cached;

    const entry = this.entries.get(key);
    const value: EntryResources = {
      entryId: ctx.entryId,
      elementKey: key,
      resources: {
        geometry: entry?.geometry ?? Resolution.idle(),
        tooltip: entry?.tooltip ?? Resolution.idle(),
        fillColor: entry?.fillColor ?? Resolution.idle(),
      },
      notices: entry?.notices ?? NO_NOTICES,
      bounds: this.bounds(ctx),
      revision: this.version,
    };

    this.snapshots.set(ctx.entryId, this.version, ctx.transform, '', value);
    return value;
  }

  /**
   * World bounds from the geometry, memoised on the render data's identity AND the
   * transform.
   *
   * Bounds are world-space, so they need the element→coordinate-system transform —
   * which is why `transform` is on `ResolveContext` and not something a renderer
   * hands down. The transform is part of the memo key: reuse the same geometry under
   * a new coordinate system and the old bounds would be wrong. The resolver owns
   * bounds (ADR 0004 §1).
   */
  private bounds(
    ctx: ResolveContext<ShapesResolveConfig, ShapesElement>
  ): AxisAlignedBounds | null {
    const entry = this.entries.get(ctx.elementKey);
    if (!entry) return null;
    const data = Resolution.lastGood(entry.geometry);
    if (!data) return null;
    if (entry.boundsSource === data && entry.boundsTransform === ctx.transform) {
      return entry.bounds ?? null;
    }

    const computed = data.circles
      ? boundsFromCircles(data.circles, ctx.transform)
      : data.polygonBinary
        ? boundsFromFlatPolygonPositions(data.polygonBinary.positions, ctx.transform)
        : data.polygons?.length
          ? boundsFromPolygons(data.polygons, ctx.transform)
          : null;
    entry.bounds = computed;
    entry.boundsSource = data;
    entry.boundsTransform = ctx.transform;
    return computed;
  }

  /**
   * A notice when the element has an associated table but not one shape joined to
   * a row of it. The geometry load already did the join (`rowIndexByFeatureIndex`),
   * so this only reads the result; the obs index it samples is cached by then.
   */
  private async unmatchedTableNotices(
    key: string,
    renderData: ShapesRenderData
  ): Promise<readonly EntryNotice[]> {
    const { featureIds, rowIndexByFeatureIndex } = renderData;
    if (featureIds.length === 0 || rowIndexByFeatureIndex.some((row) => row >= 0)) {
      return NO_NOTICES;
    }
    const associated = this.spatialData?.getAssociatedTable('shapes', key);
    if (!associated) return NO_NOTICES;
    const [tableName, table] = associated;
    const [tableId] = await table.loadObsIndex();
    return [
      tableRowsUnmatchedNotice({
        kind: 'shapes',
        elementKey: key,
        tableName,
        instanceKey: table.getTableKeys().instanceKey,
        detail:
          tableId === undefined
            ? 'the table has no rows'
            : `shape ids look like "${featureIds[0]}", table ids like "${tableId}"`,
      }),
    ];
  }

  // --- Reads ------------------------------------------------------------------

  /** The geometry, for a Renderer Adapter to project. */
  getRenderData(key: string): ShapesRenderData | undefined {
    const entry = this.entries.get(key);
    return entry ? Resolution.lastGood(entry.geometry) : undefined;
  }

  getTooltipMetadata(key: string): ShapesTooltipMetadata | undefined {
    const entry = this.entries.get(key);
    return entry ? Resolution.lastGood(entry.tooltip) : undefined;
  }

  /** The raw table rows. The COLOURS are built by the adapter — see the class doc. */
  getFillColorRows(key: string): AssociatedTableFeatureRows | undefined {
    const entry = this.entries.get(key);
    return entry ? Resolution.lastGood(entry.fillColor) : undefined;
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
    for (const listener of this.listeners) listener();
  }

  retry(key: string): void {
    const entry = this.entries.get(key);
    if (!entry) return;
    let changed = false;
    if (Resolution.isFailed(entry.geometry)) {
      entry.retryGeometry = true;
      changed = true;
    }
    // Forgetting what failed is enough: `plan()` reschedules on a mismatch.
    if (Resolution.isFailed(entry.tooltip)) {
      entry.tooltipSignature = undefined;
      changed = true;
    }
    if (Resolution.isFailed(entry.fillColor)) {
      entry.fillColorColumn = undefined;
      changed = true;
    }
    if (changed) this.notify();
  }

  evict(key: string): void {
    const existed = this.entries.delete(key);
    this.snapshots.evictByElement(key);
    // Notify so external-store consumers drop the stale snapshot immediately.
    if (existed) this.notify();
  }

  dispose(): void {
    this.entries.clear();
    this.snapshots.clear();
    this.listeners.clear();
  }
}
