/**
 * The Resource Resolver interface (ADR 0004).
 *
 * A resolver turns structural Render Stack inputs into stable loaded resources.
 * It is store-agnostic AND renderer-agnostic: it knows nothing about deck.gl,
 * React, Viv, or three.js. `tgpu-htj2k` (three.js/WebGPU, separate repo) consumes
 * the same interface `@spatialdata/vis` does — that second consumer is the whole
 * reason this lives in `core` rather than behind deck.gl.
 *
 * ## The phase separation — the load-bearing part
 *
 * | Phase      | Owner            | Purity     | When              | May start I/O?          |
 * |------------|------------------|------------|-------------------|-------------------------|
 * | `plan()`   | Resolver         | pure, sync | commit only       | no — *returns* tasks    |
 * | `load()`   | Resolver         | async      | commit only       | **yes — the only place**|
 * | `project()`| Renderer Adapter | pure, sync | end of reconcile  | no                      |
 * | `render()` | Renderer Adapter | pure, sync | during React render | no — gets no handle   |
 *
 * `project()` and `render()` are NOT on this interface. They belong to the
 * Renderer Adapter, in `@spatialdata/layers` — identity-stable memoisation is a
 * *deck* requirement (deck tears a layer down when its data identity changes), so
 * it belongs on the renderer side (ADR 0004 §4).
 *
 * The payoff is a type error, not a code-review note: because `render()` is handed
 * a frozen projected state and no engine handle, today's
 * `void engine.ensureMatchingFeaturesLoaded(...)` inside `getLayers()` **cannot
 * compile**. Its intent moves to `plan()`, which is where it always belonged —
 * both its conditions are pure functions of config and entry state.
 *
 * ## Placement is per-kind, driven by dependency (ADR 0004 §6, as amended)
 *
 * `core` defines this interface. Implementations live in the package their
 * dependencies already live in: `PointsResolver` and `ShapesResolver` in `core`
 * (every type they touch is already a `core` type); `ImagesResolver` and
 * `LabelsResolver` in `vis`, next to Viv and `avivatorish`.
 *
 * A resolver's *package* is an implementation detail. The store holds only
 * `ResourceResolver` and must never know which package an implementation came
 * from. If a `vis`-resident resolver needs something this interface does not
 * offer, that is a signal about the **interface** — not a licence to special-case
 * images.
 */

import type { EntryNotice, SpatialEntryKind } from './errors.js';
import type { Resolution } from './resolution.js';

/** World-space axis-aligned bounds: `[minX, minY, maxX, maxY]`. */
export type ResolvedBounds = [number, number, number, number];

/**
 * Everything a resolver needs to reason about one Spatial Entry, this commit.
 *
 * `TElement` is the concrete element type (`PointsElement`, `ShapesElement`, …);
 * `TConfig` is the entry's serialisable renderer props. Both are generic so that
 * `core` never has to know a renderer's prop shape.
 */
export interface ResolveContext<TConfig = unknown, TElement = unknown> {
  /** The Stack Entry's stable id — `layerId` today. */
  readonly entryId: string;
  /** The SpatialData element key. THE cache key: several entries may share one. */
  readonly elementKey: string;
  readonly kind: SpatialEntryKind;
  readonly element: TElement;
  /** Serialisable renderer props. Never a Runtime Attachment — no callbacks. */
  readonly config: TConfig;
}

/**
 * One unit of I/O. **Pure data** — no closures, no promises, no element handles.
 *
 * `plan()` returns these instead of starting work, which is what makes `plan()`
 * safely callable during render.
 */
export interface ResolveTask {
  /**
   * Identifies this request. Stable within (entry, resource) for as long as the
   * request means the same thing: **same id ⇒ dedup; different id ⇒ supersede**.
   *
   * So everything the request depends on must be IN the id. That is not incidental
   * — every one of the four known points races is a keying bug: two live requests
   * with equal keys (R1, R2), a key missing the memory cap (R3), or a key missing a
   * dimension entirely (R5).
   *
   * Step 1 does NOT act on this: resolvers keep today's in-flight-promise dedup,
   * byte for byte. This is the seam Track A's `RequestSlot` will key off, and
   * shaping it now is what lets that land without touching a public type.
   */
  readonly id: string;
  /** Which resource of the entry — 'preload' | 'catalog' | 'geometry' | 'tooltip' | … */
  readonly resource: string;
  /** Opaque to the store; only the resolver that planned it reads it. */
  readonly payload?: unknown;
}

/**
 * A resolver's per-entry output. Frozen, identity-stable, and safe to read during
 * render.
 */
export interface EntryResources {
  readonly entryId: string;
  readonly elementKey: string;
  /**
   * Failure is **per-resource, not per-entry** (ADR 0004 §3). A shapes entry with
   * a broken tooltip column must still draw its geometry, so there is no
   * entry-wide `Result` here — only a resolution per named resource.
   */
  readonly resources: Readonly<Record<string, Resolution<unknown>>>;
  /** Non-fatal facts about a *successful* resolve. Healthy data never renders as an error. */
  readonly notices: readonly EntryNotice[];
  /** World bounds, once anything is loaded. Computed by the resolver — a
   * `vis`-resident one may reach for viv's `getImageSize`; `core` never needs to. */
  readonly bounds: ResolvedBounds | null;
  /** Bumps iff anything above changed identity. Lets an adapter skip `project()`. */
  readonly revision: number;
}

export interface ResourceResolver<TConfig = unknown, TElement = unknown> {
  readonly kind: SpatialEntryKind;

  /**
   * Which resources must be `ready` before this entry can first paint.
   *
   * Data, not a switch — this is what `isBlocking` becomes. It also preserves
   * today's asymmetry honestly: points block on their preload and shapes on their
   * geometry, but a tooltip or a fill-colour column has never blocked a first
   * paint and must not start.
   */
  readonly blockingResources: readonly string[];

  /**
   * What work does this entry need? **Pure and synchronous. Must not start I/O.**
   *
   * Called on every reconcile, so it must be cheap and idempotent: returning a
   * task whose `id` matches an in-flight one is how dedup happens.
   */
  plan(ctx: ResolveContext<TConfig, TElement>): readonly ResolveTask[];

  /**
   * Do the work. **The only place I/O may start.**
   *
   * Must classify its own failures into a `Resolution.failed` via
   * `toSpatialEntryError` — checking `isCancellation(cause)` FIRST, because an
   * aborted load is a non-event and must not paint an error. It must not throw.
   */
  load(
    task: ResolveTask,
    ctx: ResolveContext<TConfig, TElement>,
    signal: AbortSignal
  ): Promise<void>;

  /**
   * The entry's resolved state. **Pure and synchronous.**
   *
   * Must return the SAME object by identity when nothing has changed — an adapter
   * memoises against it, and a fresh identity per call is a deck teardown per frame.
   */
  snapshot(ctx: ResolveContext<TConfig, TElement>): EntryResources;

  /** Subscribe to cache mutations. Returns an unsubscribe. */
  subscribe(listener: () => void): () => void;
  /** Monotonic; backs `useSyncExternalStore`. */
  getVersion(): number;
  /** Drop one element from the cache. */
  evict(elementKey: string): void;
  dispose(): void;
}
