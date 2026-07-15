import { getImageSize } from '@hms-dbmi/viv';
import type { Matrix4 } from '@math.gl/core';
import type { OmeZarrMultiscalesSource } from '@spatialdata/avivatorish';
import {
  type AxisAlignedBounds,
  boundsFromImagePixelExtents,
  type EntryResources,
  type ImageElement,
  isCancellation,
  type LabelsElement,
  type LabelsTooltipMetadata,
  loadLabelsTooltipMetadata,
  Resolution,
  type ResolveContext,
  type ResolveTask,
  type ResourceResolver,
  type SpatialData,
  toSpatialEntryError,
} from '@spatialdata/core';
import {
  buildImageChannelDefaults,
  buildLabelsChannelDefaults,
  type ImageChannelDefaults,
  type LabelsChannelDefaults,
} from '../imageLoaderChannelDefaults.js';
import { createImageLoader } from '../renderers/imageRenderer.js';

/**
 * The images and labels Resource Resolvers.
 *
 * They implement `@spatialdata/core`'s `ResourceResolver` — the same interface
 * `PointsResolver` and `ShapesResolver` implement — but they **live in
 * `@spatialdata/vis`**, and that is deliberate.
 *
 * ## Why here and not in `core`
 *
 * ADR 0004 §6 originally claimed `createImageLoader` "closes over the React
 * `VivLoaderRegistry` context", making the image loader the one genuine
 * ports-and-adapters dependency, and concluded that `core` should define a port.
 *
 * It closes over nothing. `createImageLoader` already takes `fetchMultiscales` as
 * an injected parameter; the React context is merely the DI container at the call
 * site. **The injection already existed, so there was no closure to break and no
 * port to invent.** The ADR has been amended.
 *
 * And a port would have cost something real. `avivatorish` imports React *and*
 * Viv, and is a de-vendoring holding pen for code that also lives upstream in Viv
 * and in MDV — its own README calls the serialized image-state model *"still
 * evolving"*. A port designed against it today would freeze a guess about an
 * unsettled model into the interface `tgpu-htj2k` depends on.
 *
 * Decisively: `zarrextra`'s `VivCompatiblePixelSource` **already serves both Viv
 * and `tgpu-htj2k`**, so the shared images seam already exists and sits *below* the
 * resolver. Images is the one kind of the four where the duplication argument — the
 * entire reason ADR 0004 exists — does not apply. `tgpu-htj2k` needs `PointsResolver`
 * and `ShapesResolver` from `core`; it does not need an images resolver from anyone.
 *
 * **So: the interface is in `core`; placement is per-kind, driven by dependency.**
 * These two may import Viv freely, which is also why `core` never needs raster
 * extents — world bounds are computed right here, with `getImageSize`.
 *
 * The store holds only `ResourceResolver` and cannot tell which package these came
 * from. If either of them ever needs something the interface does not offer, that
 * is a signal about the *interface* — not a licence to special-case images.
 */

/** The multiscales fetcher, injected. Supplied from `useVivLoaderRegistry()` at the call site. */
export type FetchMultiscales = (source: OmeZarrMultiscalesSource) => Promise<unknown>;

export interface RasterResolverOptions {
  fetchMultiscales?: FetchMultiscales;
  spatialData?: SpatialData;
  onStatus?: (layerId: string, resource: string, status: 'loading' | 'ready' | 'error') => void;
}

export interface ImagesResolveConfig {
  channels?: unknown;
}

export interface LabelsResolveConfig {
  tooltipFields?: string[];
  channels?: unknown;
}

/**
 * World bounds from a Viv loader's pixel extents.
 *
 * This is the line that killed the port. `core` owns world bounds (ADR 0004 §1)
 * but may not import Viv — so a `core`-resident images resolver would have needed
 * a port handing raster extents across. A `vis`-resident one just calls
 * `getImageSize`, and `core` never has to know rasters have a width.
 */
function rasterBounds(loader: unknown, transform: Matrix4): AxisAlignedBounds | null {
  const source = Array.isArray(loader) ? loader[0] : loader;
  if (!source) return null;
  try {
    const { width, height } = getImageSize(source as never);
    return boundsFromImagePixelExtents(width, height, transform);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------

interface RasterEntry<T> {
  loader: Resolution<T>;
  inFlight: Map<string, Promise<void>>;
  bounds?: AxisAlignedBounds | null;
  boundsSource?: unknown;
  snapshot?: { version: number; value: EntryResources };
}

abstract class BaseRasterResolver<TConfig, TElement, TData extends { loader: unknown }> {
  protected readonly entries = new Map<string, RasterEntry<TData>>();
  protected readonly listeners = new Set<() => void>();
  protected readonly options: RasterResolverOptions;
  protected version = 0;

  constructor(options: RasterResolverOptions = {}) {
    this.options = options;
  }

  protected entry(key: string): RasterEntry<TData> {
    let entry = this.entries.get(key);
    if (!entry) {
      entry = { loader: Resolution.idle(), inFlight: new Map() };
      this.entries.set(key, entry);
    }
    return entry;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  getVersion(): number {
    return this.version;
  }

  protected notify(): void {
    this.version += 1;
    for (const listener of this.listeners) listener();
  }

  /** The resolved loader + channel defaults — what the panels read today. */
  getLoadedData(key: string): TData | undefined {
    const entry = this.entries.get(key);
    return entry ? Resolution.lastGood(entry.loader) : undefined;
  }

  protected boundsFor(key: string, transform: Matrix4): AxisAlignedBounds | null {
    const entry = this.entries.get(key);
    if (!entry) return null;
    const data = Resolution.lastGood(entry.loader);
    if (!data) return null;
    if (entry.boundsSource === data.loader) return entry.bounds ?? null;
    const computed = rasterBounds(data.loader, transform);
    entry.bounds = computed;
    entry.boundsSource = data.loader;
    return computed;
  }

  evict(key: string): void {
    this.entries.delete(key);
  }

  dispose(): void {
    this.entries.clear();
    this.listeners.clear();
  }

  /** Shared load scaffolding: dedup by task id, stale retention, error classification. */
  protected async runLoad(
    entry: RasterEntry<TData>,
    task: ResolveTask,
    ctx: ResolveContext<TConfig, TElement>,
    produce: () => Promise<TData>
  ): Promise<void> {
    const existing = entry.inFlight.get(task.id);
    if (existing) return existing;

    const stale = Resolution.lastGood(entry.loader);
    entry.loader = Resolution.loading(stale !== undefined ? { stale } : {});
    this.options.onStatus?.(ctx.entryId, 'image', 'loading');
    this.notify();

    const run = (async () => {
      try {
        entry.loader = Resolution.ready(await produce());
        this.options.onStatus?.(ctx.entryId, 'image', 'ready');
      } catch (cause) {
        if (isCancellation(cause)) return;
        entry.loader = Resolution.failed(
          toSpatialEntryError(cause, {
            elementKey: ctx.elementKey,
            kind: ctx.kind,
            resource: 'loader',
            // A raster loader that throws failed to READ its multiscales — a load,
            // not a decode. The seam knows; the bare Error does not.
            fallback: 'load-failed',
          }),
          stale
        );
        this.options.onStatus?.(ctx.entryId, 'image', 'error');
      } finally {
        this.notify();
      }
    })().finally(() => {
      if (entry.inFlight.get(task.id) === run) entry.inFlight.delete(task.id);
    });
    entry.inFlight.set(task.id, run);
    return run;
  }
}

// ---------------------------------------------------------------------------

export class ImagesResolver
  extends BaseRasterResolver<ImagesResolveConfig, ImageElement, ImageChannelDefaults>
  implements ResourceResolver<ImagesResolveConfig, ImageElement>
{
  readonly kind = 'images' as const;
  readonly blockingResources = ['loader'] as const;

  plan(ctx: ResolveContext<ImagesResolveConfig, ImageElement>): readonly ResolveTask[] {
    const entry = this.entries.get(ctx.elementKey);
    if (!entry || Resolution.isIdle(entry.loader)) {
      return [{ id: `${ctx.elementKey}#loader`, resource: 'loader' }];
    }
    return [];
  }

  async load(
    task: ResolveTask,
    ctx: ResolveContext<ImagesResolveConfig, ImageElement>,
    _signal: AbortSignal
  ): Promise<void> {
    if (task.resource !== 'loader') return;
    const entry = this.entry(ctx.elementKey);
    await this.runLoad(entry, task, ctx, async () => {
      const loader = await createImageLoader(ctx.element, this.options.fetchMultiscales);
      return buildImageChannelDefaults(loader, ctx.element);
    });
  }

  snapshot(ctx: ResolveContext<ImagesResolveConfig, ImageElement>): EntryResources {
    const entry = this.entries.get(ctx.elementKey);
    if (entry?.snapshot && entry.snapshot.version === this.version) {
      return entry.snapshot.value;
    }
    const value: EntryResources = {
      entryId: ctx.entryId,
      elementKey: ctx.elementKey,
      resources: { loader: entry?.loader ?? Resolution.idle() },
      notices: [],
      bounds: this.boundsFor(ctx.elementKey, ctx.transform),
      revision: this.version,
    };
    if (entry) entry.snapshot = { version: this.version, value };
    return value;
  }
}

// ---------------------------------------------------------------------------

export class LabelsResolver
  extends BaseRasterResolver<LabelsResolveConfig, LabelsElement, LabelsChannelDefaults>
  implements ResourceResolver<LabelsResolveConfig, LabelsElement>
{
  readonly kind = 'labels' as const;
  readonly blockingResources = ['loader'] as const;

  private readonly tooltips = new Map<
    string,
    { signature: string; resolution: Resolution<LabelsTooltipMetadata> }
  >();

  plan(ctx: ResolveContext<LabelsResolveConfig, LabelsElement>): readonly ResolveTask[] {
    const key = ctx.elementKey;
    const tasks: ResolveTask[] = [];
    const entry = this.entries.get(key);
    if (!entry || Resolution.isIdle(entry.loader)) {
      tasks.push({ id: `${key}#loader`, resource: 'loader' });
    }
    const fields = ctx.config.tooltipFields;
    if (fields && fields.length > 0) {
      const signature = fields.join('');
      if (this.tooltips.get(key)?.signature !== signature) {
        tasks.push({
          id: `${key}#tooltip:${signature}`,
          resource: 'tooltip',
          payload: { tooltipFields: fields },
        });
      }
    }
    return tasks;
  }

  async load(
    task: ResolveTask,
    ctx: ResolveContext<LabelsResolveConfig, LabelsElement>,
    _signal: AbortSignal
  ): Promise<void> {
    const key = ctx.elementKey;

    if (task.resource === 'loader') {
      const entry = this.entry(key);
      await this.runLoad(entry, task, ctx, async () => {
        const loader = await createImageLoader(ctx.element, this.options.fetchMultiscales);
        return buildLabelsChannelDefaults(loader, ctx.element);
      });
      return;
    }

    if (task.resource === 'tooltip') {
      const fields = (task.payload as { tooltipFields: string[] }).tooltipFields;
      const signature = fields.join('');
      try {
        const metadata = await loadLabelsTooltipMetadata(
          this.options.spatialData,
          ctx.element,
          fields
        );
        this.tooltips.set(key, { signature, resolution: Resolution.ready(metadata) });
      } catch (cause) {
        if (isCancellation(cause)) return;
        this.tooltips.set(key, {
          signature,
          resolution: Resolution.failed(
            toSpatialEntryError(cause, {
              elementKey: key,
              kind: 'labels',
              resource: 'tooltip',
              fallback: 'load-failed',
            })
          ),
        });
      } finally {
        this.notify();
      }
    }
  }

  getTooltipMetadata(key: string): LabelsTooltipMetadata | undefined {
    const held = this.tooltips.get(key);
    return held ? Resolution.lastGood(held.resolution) : undefined;
  }

  snapshot(ctx: ResolveContext<LabelsResolveConfig, LabelsElement>): EntryResources {
    const entry = this.entries.get(ctx.elementKey);
    if (entry?.snapshot && entry.snapshot.version === this.version) {
      return entry.snapshot.value;
    }
    const value: EntryResources = {
      entryId: ctx.entryId,
      elementKey: ctx.elementKey,
      resources: {
        loader: entry?.loader ?? Resolution.idle(),
        tooltip: this.tooltips.get(ctx.elementKey)?.resolution ?? Resolution.idle(),
      },
      notices: [],
      bounds: this.boundsFor(ctx.elementKey, ctx.transform),
      revision: this.version,
    };
    if (entry) entry.snapshot = { version: this.version, value };
    return value;
  }

  override evict(key: string): void {
    super.evict(key);
    this.tooltips.delete(key);
  }

  override dispose(): void {
    super.dispose();
    this.tooltips.clear();
  }
}
