/**
 * Resolution — the state of one loaded resource of a Spatial Entry, **as a value**.
 *
 * See `CONTEXT.md` for the vocabulary and ADR 0004 §3 for why this lives in `core`.
 *
 * ## Resolutions are per-resource, not per-entry
 *
 * A shapes entry with a broken tooltip column must still draw its geometry. There
 * is deliberately no entry-wide `Result`.
 *
 * ## `stale` is a retention, not a guarantee
 *
 * *While it is retained*, a failed or in-flight refine keeps drawing rather than
 * blanking. It is released on eviction and on non-retryable failure, after which
 * the resource is simply not renderable. **Callers must handle the no-stale
 * case** — they may not assume a previously-ready resource stays drawable.
 *
 * ## The identity rule — load-bearing, read this before touching a render path
 *
 * Resolution values are constructed **at mutation time** and returned **by
 * reference**. Never construct one inside `project()` or `render()` from live
 * state: `Resolution.ready(v)` allocates, and a fresh identity per render is a
 * deck layer teardown per frame — which is exactly the pan-flash this whole
 * design exists to avoid. If you find yourself building a Resolution during
 * render, the state belongs one phase earlier.
 */

import type { Result } from '../types.js';
import type { EntryNotice, SpatialEntryError, SpatialEntryErrorContext } from './errors.js';
import { toSpatialEntryError } from './errors.js';

/**
 * Progress of an in-flight load.
 *
 * `done` and `scanned` differ because producers routinely examine more than they
 * keep: a feature scan reads every row group but retains only matching rows.
 */
export interface ResolutionProgress {
  /** Rows/bytes retained so far. */
  readonly done: number;
  /** Rows/bytes examined so far. `>= done` whenever the producer filters. */
  readonly scanned?: number;
  /** The denominator, when it is known. It often isn't until the scan ends. */
  readonly total?: number;
}

export type Resolution<T> =
  | { readonly status: 'idle' }
  | {
      readonly status: 'loading';
      /** What *this* load has produced so far — the streaming scan's growing buffer. */
      readonly partial?: T;
      /** The last good value from the *previous* load. See "stale is a retention" above. */
      readonly stale?: T;
      readonly progress?: ResolutionProgress;
    }
  | { readonly status: 'ready'; readonly value: T; readonly notices?: readonly EntryNotice[] }
  | { readonly status: 'failed'; readonly error: SpatialEntryError; readonly stale?: T };

const IDLE: Resolution<never> = Object.freeze({ status: 'idle' as const });

/**
 * Constructors and guards for {@link Resolution}.
 *
 * Namespaced deliberately: bare `ready` / `failed` / `loading` are far too
 * generic for `@spatialdata/core`'s top-level export surface.
 */
export const Resolution = {
  /** One frozen singleton, so `idle` is identity-stable across renders. */
  idle: <T>(): Resolution<T> => IDLE as Resolution<T>,

  loading: <T>(o?: { partial?: T; stale?: T; progress?: ResolutionProgress }): Resolution<T> => ({
    status: 'loading',
    ...(o?.partial !== undefined ? { partial: o.partial } : {}),
    ...(o?.stale !== undefined ? { stale: o.stale } : {}),
    ...(o?.progress !== undefined ? { progress: o.progress } : {}),
  }),

  ready: <T>(value: T, notices?: readonly EntryNotice[]): Resolution<T> => ({
    status: 'ready',
    value,
    ...(notices !== undefined && notices.length > 0 ? { notices } : {}),
  }),

  failed: <T>(error: SpatialEntryError, stale?: T): Resolution<T> => ({
    status: 'failed',
    error,
    ...(stale !== undefined ? { stale } : {}),
  }),

  isIdle: <T>(r: Resolution<T>): r is Extract<Resolution<T>, { status: 'idle' }> =>
    r.status === 'idle',
  isLoading: <T>(r: Resolution<T>): r is Extract<Resolution<T>, { status: 'loading' }> =>
    r.status === 'loading',
  isReady: <T>(r: Resolution<T>): r is Extract<Resolution<T>, { status: 'ready' }> =>
    r.status === 'ready',
  isFailed: <T>(r: Resolution<T>): r is Extract<Resolution<T>, { status: 'failed' }> =>
    r.status === 'failed',

  /** The settled value, and only that. `undefined` while loading, even if `stale` exists. */
  readyValue: <T>(r: Resolution<T>): T | undefined => (r.status === 'ready' ? r.value : undefined),

  /**
   * The newest drawable value: `ready.value`, else a retained `stale`.
   *
   * This is what a base layer draws. Note it is deliberately **not** unioned with
   * `partial` — see below.
   */
  lastGood: <T>(r: Resolution<T>): T | undefined => {
    if (r.status === 'ready') return r.value;
    if (r.status === 'loading' || r.status === 'failed') return r.stale;
    return undefined;
  },

  /** The in-flight load's growing buffer, if it has produced one. */
  partialValue: <T>(r: Resolution<T>): T | undefined =>
    r.status === 'loading' ? r.partial : undefined,
} as const;

// There is deliberately no `Resolution.valueOf()` collapsing lastGood ?? partial.
// The points render path draws `lastGood` as the base layer AND `partial` as a
// separate overlay sub-layer, simultaneously. A helper that merged them would
// destroy the exact distinction the render path depends on.

/**
 * Lift a `Result` into a `Resolution`.
 *
 * This is why `Resolution` lives in `core`: the `Result` it lifts is already
 * here. Its one producer on this path is `AbstractSpatialElement.getTransformation()`,
 * which returns `Result<BaseTransformation, CoordinateSystemNotFoundError>` — and
 * that error class is the one input `toSpatialEntryError` classifies losslessly.
 */
export function fromResult<T, E>(
  result: Result<T, E>,
  ctx: SpatialEntryErrorContext
): Resolution<T> {
  return result.ok
    ? Resolution.ready(result.value)
    : Resolution.failed(toSpatialEntryError(result.error, ctx));
}
