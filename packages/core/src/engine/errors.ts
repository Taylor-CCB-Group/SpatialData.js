/**
 * Spatial Entry Error — the typed domain-failure channel for a Resource Resolver.
 * Entry Notice — the non-fatal channel beside it.
 *
 * See `CONTEXT.md` for the vocabulary and ADR 0004 for why these live in `core`.
 *
 * ## The one thing to understand about `toSpatialEntryError`
 *
 * **It classifies from the seam, not from the throw.**
 *
 * `core`'s leaf loaders throw bare `Error(string)` and will keep doing so — the
 * resolver classifies at the seam, and pushing typed errors down into every
 * loader is explicitly not this design. More decisively: anything that crossed
 * the points-worker boundary has *already* lost its type, because the worker's
 * failure channel is `{ ok: false; error: string }` (`pointsWorkerProtocol.ts`).
 * By the time a worker-side decode failure reaches us it is a string. No amount
 * of cleverness in this module recovers what the postMessage boundary threw away.
 *
 * So the *caller* supplies the answer. `SpatialEntryErrorContext.fallback` says
 * what this operation fails as when the cause carries no type of its own — and
 * the seam always knows what it was doing, even when the throw doesn't.
 *
 * **Message-sniffing is banned** beyond the single quarantined `recognise()`
 * below. It is a smell, and here it also simply cannot work.
 */

import { CoordinateSystemNotFoundError } from '../models/index.js';
import { PointsPreloadTooLargeError } from '../pointsLimits.js';

/** The four Spatial Entry kinds. */
export type SpatialEntryKind = 'points' | 'shapes' | 'images' | 'labels';

export type SpatialEntryErrorKind =
  | 'coordinate-system-not-found'
  | 'element-not-found'
  | 'unsupported-format'
  | 'points-preload-too-large'
  | 'worker-unavailable'
  | 'decode-failed'
  | 'load-failed';

/**
 * The kinds a seam may nominate as its `fallback`.
 *
 * Deliberately **narrower** than `SpatialEntryErrorKind`:
 * `coordinate-system-not-found` and `points-preload-too-large` carry structured
 * payload (available coordinate systems; row counts) that only their typed error
 * class can supply. They are reachable *only* through the `instanceof` tier of
 * `toSpatialEntryError`. Naming one as a fallback would be a promise the
 * classifier cannot keep — so the type forbids it rather than degrading at
 * runtime.
 */
export type SpatialEntryErrorFallbackKind = Exclude<
  SpatialEntryErrorKind,
  'coordinate-system-not-found' | 'points-preload-too-large'
>;

interface SpatialEntryErrorBase {
  /** Human-readable, and safe to show. Every case carries what the UI needs to explain itself. */
  readonly message: string;
  /**
   * Gates a Retry affordance. This — not the union — is what stops a failed scan
   * settling permanently. See ADR 0004 §3.
   */
  readonly retryable: boolean;
  /** Preserved for logs. Never for the UI, and never for classification. */
  readonly cause?: unknown;
}

export type SpatialEntryError =
  | (SpatialEntryErrorBase & {
      readonly kind: 'coordinate-system-not-found';
      readonly retryable: false;
      readonly coordinateSystem: string;
      readonly elementKey: string;
      readonly availableCoordinateSystems: readonly string[];
    })
  | (SpatialEntryErrorBase & {
      readonly kind: 'element-not-found';
      readonly retryable: false;
      readonly elementKey: string;
      readonly elementType?: string;
    })
  | (SpatialEntryErrorBase & {
      readonly kind: 'unsupported-format';
      readonly retryable: false;
      readonly detail: string;
    })
  | (SpatialEntryErrorBase & {
      readonly kind: 'points-preload-too-large';
      readonly retryable: false;
      readonly rowCount: number;
      readonly maxRows: number;
    })
  | (SpatialEntryErrorBase & {
      readonly kind: 'worker-unavailable';
      readonly retryable: true;
      readonly detail: string;
    })
  | (SpatialEntryErrorBase & {
      readonly kind: 'decode-failed';
      readonly retryable: true;
      readonly resource: string;
      readonly detail: string;
    })
  | (SpatialEntryErrorBase & {
      readonly kind: 'load-failed';
      readonly retryable: true;
      readonly resource: string;
      readonly detail: string;
    });

/**
 * A non-fatal domain fact about a **successfully** resolved entry. A channel
 * distinct from `SpatialEntryError`, so healthy data never renders as an error.
 *
 * Note what is *not* here: absence. A points element with no `feature_key` is a
 * settled fact — `ready(null)` — not a failure and not a notice.
 */
export type EntryNotice =
  | {
      readonly kind: 'preload-truncated';
      readonly message: string;
      readonly loaded: number;
      readonly total: number;
    }
  | {
      readonly kind: 'selection-served-from-memory';
      readonly message: string;
      readonly coveredCodes: number;
    }
  | { readonly kind: 'catalog-is-resident-preview'; readonly message: string }
  | {
      readonly kind: 'channel-defaults-fallback';
      readonly message: string;
      readonly reason: string;
    };

/**
 * What the seam was doing when it threw. Supplied by the caller, because the
 * caller is the only one who still knows.
 */
export interface SpatialEntryErrorContext {
  readonly elementKey: string;
  readonly kind: SpatialEntryKind;
  /** Which resource of the entry — 'preload' | 'catalog' | 'geometry' | 'tooltip' | … */
  readonly resource: string;
  /**
   * What this operation fails as when the cause carries no type.
   * The SEAM knows what it was doing; the throw does not.
   */
  readonly fallback: SpatialEntryErrorFallbackKind;
}

/**
 * Is this an abort, rather than a failure?
 *
 * **Call this before the classifier at every seam.** Cancellation is a
 * non-event: superseding a load is normal operation, not a domain failure, and
 * there is deliberately no `cancelled` case in `SpatialEntryError`. Skip this
 * check and every memory-cap drag paints an error where today there is none.
 */
export function isCancellation(cause: unknown): boolean {
  if (cause instanceof DOMException) return cause.name === 'AbortError';
  return (
    typeof cause === 'object' && cause !== null && 'name' in cause && cause.name === 'AbortError'
  );
}

function messageOf(cause: unknown): string {
  if (cause instanceof Error) return cause.message;
  if (typeof cause === 'string') return cause;
  return String(cause);
}

/**
 * The one sanctioned message-sniff, quarantined here so it cannot spread.
 *
 * `worker-unavailable` is thrown from *inside* seams whose `fallback` is
 * `decode-failed` (`VPointsSource` falls back to the main thread when the worker
 * can't service a request), so context alone cannot reach it. It is `retryable`
 * where `decode-failed` is not always meaningfully so, which is why the
 * distinction is worth one narrow recogniser.
 *
 * Throw sites: `points-worker.ts` ("readParquetRowGroup is unavailable in points
 * worker"), `pointsWorkerScan.ts` ("readParquetRowGroup is unavailable").
 *
 * TODO(Track A): delete this. Track A owns the worker protocol and can introduce
 * a typed `PointsWorkerUnavailableError`, at which point the `instanceof` tier
 * covers it losslessly and this function goes away.
 */
function recognise(cause: unknown): SpatialEntryErrorFallbackKind | undefined {
  const message = messageOf(cause);
  if (message.includes('readParquetRowGroup') && message.includes('unavailable')) {
    return 'worker-unavailable';
  }
  return undefined;
}

/** Total over `SpatialEntryErrorFallbackKind` — every case is constructible from an untyped cause. */
function build(
  kind: SpatialEntryErrorFallbackKind,
  cause: unknown,
  ctx: SpatialEntryErrorContext
): SpatialEntryError {
  const message = messageOf(cause);
  switch (kind) {
    case 'element-not-found':
      return {
        kind,
        message,
        retryable: false,
        elementKey: ctx.elementKey,
        elementType: ctx.kind,
        cause,
      };
    case 'unsupported-format':
      return { kind, message, retryable: false, detail: message, cause };
    case 'worker-unavailable':
      return { kind, message, retryable: true, detail: message, cause };
    case 'decode-failed':
      return { kind, message, retryable: true, resource: ctx.resource, detail: message, cause };
    case 'load-failed':
      return { kind, message, retryable: true, resource: ctx.resource, detail: message, cause };
  }
}

/**
 * Turn a thrown thing into a value. **The single place a throw becomes a
 * `SpatialEntryError`** — do not classify anywhere else.
 *
 * Three tiers, in order:
 *   1. `instanceof` — the only lossless tier. `core` has exactly two typed error
 *      classes, so exactly two inputs classify perfectly.
 *   2. `recognise()` — one quarantined message-sniff for `worker-unavailable`.
 *   3. `ctx.fallback` — everything else. The seam knows; the throw doesn't.
 *
 * Callers must check {@link isCancellation} first: an aborted load is not a
 * failure and must not reach here.
 */
export function toSpatialEntryError(
  cause: unknown,
  ctx: SpatialEntryErrorContext
): SpatialEntryError {
  if (cause instanceof CoordinateSystemNotFoundError) {
    return {
      kind: 'coordinate-system-not-found',
      message: cause.message,
      retryable: false,
      coordinateSystem: cause.coordinateSystem,
      elementKey: cause.elementKey,
      availableCoordinateSystems: cause.availableCoordinateSystems,
      cause,
    };
  }

  if (cause instanceof PointsPreloadTooLargeError) {
    return {
      kind: 'points-preload-too-large',
      message: cause.message,
      retryable: false,
      rowCount: cause.rowCount,
      maxRows: cause.maxRows,
      cause,
    };
  }

  return build(recognise(cause) ?? ctx.fallback, cause, ctx);
}
