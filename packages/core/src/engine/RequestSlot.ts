/**
 * `RequestSlot<K, V>` — one in-flight-or-settled resource, as a value.
 *
 * This is the primitive Track A (ADR 0004 §Step 2) uses to replace the four
 * hand-rolled dedup/supersede/settle implementations inside `PointsResolver`'s
 * `PointsEntry` (`ensureLoaded`, `ensureFeatureCatalog`, `ensureRowFeatureCodes`,
 * `ensureMatchingFeaturesLoaded`). Each of those grew its own ad-hoc mutable
 * bookkeeping — a `loading` promise here, a `signature` guard there, a `finally`
 * that clears markers only `if (entry.memoryCap === memoryCap)` — and every one of
 * the four known points races (R1, R2, R3, R5) is a bug in that bookkeeping. A slot
 * makes the bookkeeping one tested thing.
 *
 * ## The two rules that make it correct
 *
 * 1. **Supersession by record identity, never by value.** Each `request` allocates
 *    an `InFlight` record. Every async continuation — success, failure, and each
 *    streamed `emit` — first checks `if (this.current !== record) return`. A load
 *    that has been superseded cannot write anything: not its result, not its error,
 *    not a late progress tick. This is the exact discipline `SpatialEntryStore`
 *    already uses for its per-task `AbortController`s, lifted to the value level.
 *    R1 and R2 are two live loads with equal keys clobbering each other; this rule
 *    is what forbids it.
 *
 * 2. **Everything the request depends on lives in `K`.** Dedup is `equals(key,
 *    currentKey)`; anything not in the key cannot supersede. R3 (a cap raise served
 *    by the smaller scan) and R5 (row codes loaded at the wrong cap) are both keys
 *    that omit a dimension — so callers put the memory cap *in* the key, exactly as
 *    `ResolveTask.id` already carries it.
 *
 * ## Failure is a state
 *
 * A rejected loader becomes `Resolution.failed(error, stale)` via
 * `toSpatialEntryError` — not a `console.error` and a dead status. `retry()` re-runs
 * the last request's loader, which is what unsticks a permanently-settled catalog
 * scan (ADR 0004 §3). Cancellation is checked first and is a non-event: a
 * superseded or aborted load reverts to the last good value, it does not paint an
 * error.
 *
 * ## Identity discipline
 *
 * `resolution` is constructed at mutation time and returned by reference — never
 * rebuilt on read. A resolver's `snapshot()` reads `slot.resolution` straight
 * through, so a fresh identity per render would be a deck teardown per frame (see
 * `resolution.ts` "the identity rule"). The only values that change identity are
 * the ones a load actually produces.
 */

import { isCancellation, type SpatialEntryErrorContext, toSpatialEntryError } from './errors.js';
import { Resolution, type ResolutionProgress } from './resolution.js';

/** What a slot's loader is handed: the abort signal the slot owns, and a way to
 * publish an in-flight partial. Both are inert once the request is superseded. */
export interface SlotLoadContext<V> {
  /** Aborted when this request is superseded (or the slot is reset/disposed). */
  readonly signal: AbortSignal;
  /**
   * Publish the streaming load's growing value (+ progress). Dropped silently once
   * this request is no longer current — a late tick from a superseded scan cannot
   * repaint the live one.
   *
   * `options.silent` updates the value **without** firing `onChange`: use it to keep
   * the partial data fresh on every producer tick while throttling how often the
   * host re-renders. The value's identity still changes, so a getter reading it sees
   * the update; only the notification is suppressed.
   */
  emit(partial: V, progress?: ResolutionProgress, options?: { silent?: boolean }): void;
}

/** Runs one request. Returns the settled value; may `emit` partials along the way. */
export type SlotLoader<V> = (ctx: SlotLoadContext<V>) => Promise<V>;

export interface RequestSlotOptions<K> {
  /** Classifier context for failures this slot's loaders throw. `elementKey`/`kind`
   * are fixed per slot; `resource`/`fallback` name what the loader was doing. */
  readonly context: SpatialEntryErrorContext;
  /** Key equality. Defaults to `Object.is`; keep `K` a value with meaningful `===`
   * (a primitive, or an interned string like `` `${signature}#${cap}` ``). */
  readonly equals?: (a: K, b: K) => boolean;
  /** Invoked after any resolution change, so the owner can bump a version / notify. */
  readonly onChange?: () => void;
  /**
   * Whether a transition *into or within* the `loading` state fires `onChange`.
   * Default `true`. Set `false` for a slot whose loading-start (and streamed
   * partials) should NOT trigger a host re-render because the drawable value — the
   * retained `stale` — has not changed: the resident preload and its row codes keep
   * the previous batch on screen through a reload, so only their *settle* is a
   * re-render (a catalog spinner, by contrast, wants the loading transition). This
   * is what keeps `notify()` counts identical to the pre-slot engine.
   */
  readonly notifyOnLoading?: boolean;
}

interface InFlight<K> {
  readonly key: K;
  readonly controller: AbortController;
  /** Assigned synchronously right after construction; never observed before then. */
  promise: Promise<void>;
}

export class RequestSlot<K, V> {
  private readonly context: SpatialEntryErrorContext;
  private readonly equals: (a: K, b: K) => boolean;
  private readonly onChange: (() => void) | undefined;
  private readonly notifyOnLoading: boolean;

  private current: InFlight<K> | undefined;
  private _resolution: Resolution<V> = Resolution.idle();
  /** Key of the last `ready` value — drives the "already satisfied" dedup and is
   * the base `retry()` re-runs. Meaningful only while `status === 'ready'`. */
  private readyKey: K | undefined;
  /** The last request, retained so `retry()` can re-run it verbatim. */
  private lastRequest: { key: K; loader: SlotLoader<V> } | undefined;

  constructor(options: RequestSlotOptions<K>) {
    this.context = options.context;
    this.equals = options.equals ?? Object.is;
    this.onChange = options.onChange;
    this.notifyOnLoading = options.notifyOnLoading ?? true;
  }

  // --- Reads ------------------------------------------------------------------

  /** The slot's state as a value. Identity-stable between mutations. */
  get resolution(): Resolution<V> {
    return this._resolution;
  }

  /** The settled value, and only that — `undefined` while loading, even with a stale. */
  get value(): V | undefined {
    return Resolution.readyValue(this._resolution);
  }

  /** The newest drawable value: `ready`, else a retained `stale`. */
  get lastGood(): V | undefined {
    return Resolution.lastGood(this._resolution);
  }

  /** The in-flight load's growing buffer, if it has produced one. */
  get partial(): V | undefined {
    return Resolution.partialValue(this._resolution);
  }

  get isLoading(): boolean {
    return this._resolution.status === 'loading';
  }

  get isReady(): boolean {
    return this._resolution.status === 'ready';
  }

  get isFailed(): boolean {
    return this._resolution.status === 'failed';
  }

  /** The key currently loading, if any — for adequacy checks against a new request. */
  get pendingKey(): K | undefined {
    return this.current?.key;
  }

  /** The key of the settled value, if `ready`. */
  get settledKey(): K | undefined {
    return this._resolution.status === 'ready' ? this.readyKey : undefined;
  }

  /** The in-flight promise, if any — for awaiting or returning from a dedup. */
  get pending(): Promise<void> | undefined {
    return this.current?.promise;
  }

  // --- Mutations --------------------------------------------------------------

  /**
   * Ask the slot for `key`. **Dedups** an in-flight or already-settled request for
   * the same key; otherwise **supersedes**: aborts the previous load, retains its
   * last good value as `stale`, and runs `loader`.
   *
   * Returns the promise of whichever load now serves this key (the existing one on
   * a dedup, the new one on a supersede).
   */
  request(key: K, loader: SlotLoader<V>): Promise<void> {
    this.lastRequest = { key, loader };

    const current = this.current;
    if (current && this.equals(current.key, key)) {
      return current.promise; // same key, still in flight → dedup
    }
    if (
      !current &&
      this._resolution.status === 'ready' &&
      this.readyKey !== undefined &&
      this.equals(this.readyKey, key)
    ) {
      return Promise.resolve(); // already satisfied for this key → no-op
    }

    // Supersede. Capturing `stale` now chains it across repeated supersessions,
    // because `lastGood` already reads through a prior `loading.stale`.
    current?.controller.abort();
    const stale = Resolution.lastGood(this._resolution);
    const controller = new AbortController();
    const record: InFlight<K> = {
      key,
      controller,
      promise: undefined as unknown as Promise<void>,
    };
    this.current = record;
    this.set(Resolution.loading(stale !== undefined ? { stale } : {}));

    const run = async (): Promise<void> => {
      try {
        const value = await loader({
          signal: controller.signal,
          emit: (partial, progress, options) => {
            if (this.current !== record) return; // superseded → drop the tick
            // Update the partial value (identity changes so a getter sees it); notify
            // unless silent — the caller throttles re-renders while keeping data fresh.
            this._resolution = Resolution.loading({
              ...(stale !== undefined ? { stale } : {}),
              partial,
              ...(progress !== undefined ? { progress } : {}),
            });
            if (!options?.silent) this.onChange?.();
          },
        });
        if (this.current !== record) return; // superseded → drop the result
        this.current = undefined;
        this.readyKey = key;
        this.set(Resolution.ready(value));
      } catch (cause) {
        if (this.current !== record) return; // superseded → not our failure
        this.current = undefined;
        if (isCancellation(cause) || controller.signal.aborted) {
          // A non-event: fall back to the last good value rather than paint an error.
          this.set(stale !== undefined ? Resolution.ready(stale) : Resolution.idle());
          if (stale === undefined) this.readyKey = undefined;
        } else {
          this.set(Resolution.failed(toSpatialEntryError(cause, this.context), stale));
        }
      }
    };
    record.promise = run();
    return record.promise;
  }

  /**
   * Set `ready(value)` for `key` directly, cancelling any in-flight load. For
   * values produced *outside* the slot's own loader — the resident-preview catalog
   * and row codes that fall out of the geometry preload's single decode, and the
   * in-memory cap shed (a lower cap slices the resident batch to a new key without
   * re-fetching).
   */
  settle(key: K, value: V): void {
    this.current?.controller.abort();
    this.current = undefined;
    this.readyKey = key;
    this.set(Resolution.ready(value));
  }

  /** Re-run the last request's loader. The retry affordance behind a failed state. */
  retry(): Promise<void> | undefined {
    if (!this.lastRequest) return undefined;
    if (this.current) return this.current.promise; // already (re)loading
    // Clear the ready-key short-circuit so an unchanged key still re-runs.
    this.readyKey = undefined;
    return this.request(this.lastRequest.key, this.lastRequest.loader);
  }

  /** Abort any in-flight load and return to `idle`. For eviction / disposal. */
  reset(): void {
    this.current?.controller.abort();
    this.current = undefined;
    this.readyKey = undefined;
    this.lastRequest = undefined;
    this.set(Resolution.idle());
  }

  private set(next: Resolution<V>): void {
    this._resolution = next;
    if (next.status === 'loading' && !this.notifyOnLoading) return;
    this.onChange?.();
  }
}
