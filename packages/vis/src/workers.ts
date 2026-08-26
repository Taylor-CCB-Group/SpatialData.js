import {
  enableParquetWorker,
  isParquetWorkerEnabled,
  setParquetWorkerRequestTimeout,
} from '@spatialdata/core';
import { type EnsureCodecWorkersOptions, ensureCodecWorkers } from './codecWorkers';

export type EnsureParquetWorkerOptions = {
  /**
   * Where the worker bundle lives, from an import your bundler resolves:
   * `import workerUrl from '@spatialdata/core/parquet-worker?worker&url'`.
   *
   * Omit only when core is loaded as published ESM without being re-bundled — see
   * the "Bundling into an application" docs page.
   */
  workerUrl?: string | URL;
  /**
   * Build the Worker yourself, for bundlers that cannot hand back a URL for a
   * *bundled* worker — webpack is the case this exists for. Takes precedence over
   * {@link workerUrl}; see `enableParquetWorker` in core for the why.
   *
   * The URL must point at a one-line entry file in YOUR source, not at the bare
   * `@spatialdata/core/parquet-worker` specifier — that makes webpack emit core's
   * published worker entry as an unbundled static asset whose every import 404s.
   *
   * ```ts
   * // parquetWorkerEntry.ts
   * import '@spatialdata/core/parquet-worker';
   * ```
   *
   * ```ts
   * ensureWorkers({
   *   parquet: {
   *     createWorker: () =>
   *       new Worker(new URL('./parquetWorkerEntry.ts', import.meta.url), {
   *         type: 'module',
   *       }),
   *   },
   * });
   * ```
   */
  createWorker?: () => Worker;
  /**
   * Per-request budget before a silent worker is treated as stuck and the caller
   * falls back to the main thread. Defaults to 30s; a large transcripts decode
   * legitimately runs longer than that.
   */
  requestTimeoutMs?: number;
};

export type EnsureWorkersOptions = {
  /** Zarr chunk decode, for imagery and labels. `false` to leave it off. */
  codec?: EnsureCodecWorkersOptions | false;
  /** Parquet decode and scans, for points, shapes and tables. `false` to leave it off. */
  parquet?: EnsureParquetWorkerOptions | false;
};

/** Which workers are running after the call. */
export type WorkersEnabled = {
  codec: boolean;
  parquet: boolean;
};

/**
 * Whether the parquet worker has been started once already.
 *
 * `enableParquetWorker` tears down and rebuilds on every call, and it clears core's
 * dead-worker latch as it goes, so an `ensure` that called it repeatedly would
 * rebuild a doomed worker on every render. One attempt per page; a host that really
 * wants to retry with a different URL calls `enableParquetWorker` directly.
 */
let parquetAttempted = false;

function ensureParquetWorker(options: EnsureParquetWorkerOptions): boolean {
  if (typeof Worker === 'undefined') {
    return false;
  }
  if (!parquetAttempted) {
    parquetAttempted = true;
    enableParquetWorker({
      ...(options.workerUrl ? { workerUrl: options.workerUrl } : {}),
      ...(options.createWorker ? { createWorker: options.createWorker } : {}),
    });
    if (options.requestTimeoutMs !== undefined) {
      setParquetWorkerRequestTimeout(options.requestTimeoutMs);
    }
  }
  return isParquetWorkerEnabled();
}

/**
 * Start every worker this library can use, in one call.
 *
 * ```ts
 * import workerUrl from '@spatialdata/core/parquet-worker?worker&url';
 * ensureWorkers({ parquet: { workerUrl } });
 * ```
 *
 * The two are asymmetric and it is worth knowing why: the codec worker ships
 * self-contained, so your bundler finds it on its own, while the parquet worker has
 * to be built by your bundler from the URL import above. Both are idempotent, so
 * this is safe to call from a component.
 *
 * Options are per-worker and every one is optional, so `ensureWorkers()` is a valid
 * call that turns both on with their defaults. Pass `false` for either to leave it
 * off. Renderer paths call {@link ensureCodecWorkers} themselves, so the reason to
 * call this is the parquet worker — or wanting the pair up before any UI mounts.
 *
 * Returns what is actually running, which is not always what was asked for: neither
 * worker starts outside a browser, and the parquet worker reports `false` from here
 * on if it fails to load, so `result.parquet` is worth gating on-demand feature
 * loading UI on.
 */
export function ensureWorkers(options: EnsureWorkersOptions = {}): WorkersEnabled {
  return {
    codec: options.codec === false ? false : ensureCodecWorkers(options.codec),
    parquet: options.parquet === false ? false : ensureParquetWorker(options.parquet ?? {}),
  };
}
