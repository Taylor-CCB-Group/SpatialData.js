import { tableFromIPC } from 'apache-arrow';
import type { PointsFeatureCatalog } from '../pointsTiling.js';
import type { FlatShapeGeometry } from '../shapesGeometryDecode.js';
import type { PointsColumnarData } from '../spatialViewFit.js';
import {
  columnarDataFromWorkerResult,
  type ParquetRowGroupBytesChunk,
  type ParquetWorkerMessage,
  type ParquetWorkerPayload,
  type ParquetWorkerRequest,
  type ParquetWorkerResponse,
  type ParquetWorkerStreamChunk,
  type PointsBounds,
} from './parquetWorkerProtocol.js';

let worker: Worker | undefined;
let nextRequestId = 0;

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timeout?: ReturnType<typeof setTimeout>;
  /**
   * Set only for a STREAMING request. Its presence is what makes an interim
   * message legal for this id — and what tells the timeout and the abort path to
   * send the worker a cancel, since a stream it is not told about keeps fetching.
   */
  onChunk?: (chunk: ParquetWorkerStreamChunk) => void;
  /**
   * Whether any interim chunk has been delivered. A stream that fails after this
   * has already handed the caller usable rows, so the failure is not equivalent
   * to one that failed before producing anything — see the note on
   * {@link streamGeometryWithFeaturesInWorker}.
   */
  deliveredChunk: boolean;
  /** Detach the abort listener when the request settles, however it settles. */
  removeAbortListener?: () => void;
};

const pending = new Map<number, PendingRequest>();

// Safety net: if the worker was enabled but is not functionally wired (e.g. a
// host points enableParquetWorker() at a URL that loads but whose module never
// posts a response), a request would otherwise await forever. After this budget
// with no reply we reject the request so the caller falls back to the main
// thread (every *InWorker helper is wrapped in a try/catch fallback). Generous
// by default because a working worker legitimately spends many seconds decoding
// large parquet; the timeout is meant to catch a *silent* worker, not a slow one.
//
// It measures time SINCE THE LAST MESSAGE for this request, not time since the
// request was posted. For the request/response types those are the same thing —
// exactly one message ever arrives. For a stream they are not: a 4M-row preload
// runs for minutes while posting a batch every few hundred ms, and a
// time-since-posted budget would abandon a perfectly healthy stream mid-flight.
// Re-arming per message keeps the meaning the comment above claims: catch a
// worker that has gone silent, not one that is taking a while.
let requestTimeoutMs = 30_000;

/** Override the per-request worker timeout (ms). Set to 0/Infinity to disable. */
export function setParquetWorkerRequestTimeout(ms: number) {
  requestTimeoutMs = ms;
}

/** Remove a pending request, clearing its timeout, and return its callbacks. */
function settlePending(id: number) {
  const entry = pending.get(id);
  if (!entry) {
    return undefined;
  }
  if (entry.timeout !== undefined) {
    clearTimeout(entry.timeout);
  }
  entry.removeAbortListener?.();
  pending.delete(id);
  return entry;
}

/**
 * (Re)start the silence watchdog for a still-pending request. Called when the
 * request is posted and again after every message it receives, so the budget is
 * time-since-last-message; see {@link requestTimeoutMs}.
 */
function armTimeout(id: number) {
  const entry = pending.get(id);
  if (!entry) {
    return;
  }
  if (entry.timeout !== undefined) {
    clearTimeout(entry.timeout);
    entry.timeout = undefined;
  }
  if (!(requestTimeoutMs > 0 && Number.isFinite(requestTimeoutMs))) {
    return;
  }
  const budget = requestTimeoutMs;
  entry.timeout = setTimeout(() => {
    const stalled = settlePending(id);
    if (!stalled) {
      return;
    }
    if (stalled.onChunk) {
      // Stop the worker fetching a payload nobody is left to receive.
      cancelWorkerStream(id);
    }
    stalled.reject(
      new Error(
        stalled.deliveredChunk
          ? `Parquet worker stream went quiet for ${budget}ms; falling back to the main thread`
          : `Parquet worker did not respond within ${budget}ms; falling back to the main thread`
      )
    );
  }, budget);
}

/**
 * Ask the worker to abandon a stream, fire and forget.
 *
 * The cancel travels with a fresh id and registers no pending entry, so the
 * worker's acknowledgement lands on an unknown id and is ignored. Awaiting it
 * would only add a second request that can itself time out, on a path that is
 * already giving up.
 */
function cancelWorkerStream(streamRequestId: number) {
  const activeWorker = worker;
  if (!activeWorker) {
    return;
  }
  const message: ParquetWorkerMessage = {
    id: ++nextRequestId,
    direction: 'request',
    request: { type: 'cancelParquetStream', streamRequestId },
  };
  activeWorker.postMessage(message);
}

/**
 * Whether this worker has ever answered — the test for "did it actually load?".
 *
 * A worker whose URL 404s fires one `error` event and is then silent forever, which
 * has to be told apart from a live worker that threw on one request: the first is a
 * wiring mistake to give up on, the second leaves the worker usable.
 */
let workerHasAnswered = false;
/**
 * Latch: the worker failed to load, so `ensureParquetWorker` should stop rebuilding
 * it. An explicit `enableParquetWorker()` clears it — the caller is presumably
 * passing a different `workerUrl`.
 */
let startupFailed = false;

let enabled = false;
// Parquet worker is opt-in: hosts call enableParquetWorker() (or
// setParquetWorkerDefaultEnabled(true)) once they have wired the worker bundle.
// Auto-enabling in every browser caused loadPoints() to hang forever wherever
// the worker isn't functionally wired (e.g. Vite dev serving core from source),
// because the worker branch awaits a response that never arrives and the
// main-thread fallback only triggers on a rejection, not a stuck promise.
let defaultEnabled = false;

function ensureWorkerListener() {
  if (!worker) {
    return;
  }
  worker.onmessage = (event: MessageEvent<ParquetWorkerMessage>) => {
    const message = event.data;
    if (message.direction === 'stream') {
      workerHasAnswered = true;
      // Deliberately `pending.get`, not `settlePending`: an interim message must
      // leave the entry in place, because the terminal response is still to come.
      // This is the whole difference between this protocol and the strict
      // request/response one it grew out of.
      const streaming = pending.get(message.id);
      if (!streaming?.onChunk) {
        // Either the request already settled (timed out, aborted, or the worker
        // died) and a batch was in flight behind the cancel, or a non-streaming
        // request somehow got one. Dropping it is right in both cases.
        return;
      }
      streaming.deliveredChunk = true;
      armTimeout(message.id);
      try {
        streaming.onChunk(message.chunk);
      } catch (error) {
        // The consumer threw on a batch, so it cannot use the rest of the stream.
        settlePending(message.id)?.reject(
          error instanceof Error ? error : new Error(String(error))
        );
        cancelWorkerStream(message.id);
      }
      return;
    }
    if (message.direction !== 'response') {
      return;
    }
    workerHasAnswered = true;
    const entry = settlePending(message.id);
    if (!entry) {
      return;
    }
    if (message.response.ok) {
      entry.resolve(message.response.result);
    } else {
      entry.reject(new Error(message.response.error));
    }
  };
  worker.onerror = (event) => {
    const detail = event.message || 'Parquet worker error';
    if (workerHasAnswered) {
      // A live worker threw: reject what is in flight (every `*InWorker` helper
      // falls back on rejection) and let the next request try again.
      rejectAllPending(new Error(detail));
      return;
    }
    // Never answered, so it never loaded — usually a `workerUrl` that does not
    // resolve. Give up on it, rather than leave `isParquetWorkerEnabled()` true for
    // a worker that cannot reply: callers then take their main-thread fallback, and
    // the one caller without one fails immediately instead of hanging to a timeout.
    disableParquetWorker(
      new Error(
        `Parquet worker failed to start (${detail}); falling back to the main thread. ` +
          'If the worker bundle is not served next to @spatialdata/core, pass its URL: ' +
          'enableParquetWorker({ workerUrl }).'
      )
    );
    startupFailed = true; // After the disable, which clears it.
    console.warn(
      `[@spatialdata/core] parquet worker failed to start (${detail}); ` +
        'continuing on the main thread. Pass enableParquetWorker({ workerUrl }) with a ' +
        'bundler-resolved URL for @spatialdata/core/parquet-worker.'
    );
  };
}

type PostRequestOptions = {
  /** Provide to receive interim batches; see {@link PendingRequest.onChunk}. */
  onChunk?: (chunk: ParquetWorkerStreamChunk) => void;
  /**
   * Abandon the request when this fires. For a stream that also posts a cancel,
   * so a superseded load stops costing bandwidth in the worker rather than
   * merely stopping being listened to.
   */
  signal?: AbortSignal;
};

function postRequest<T>(
  request: ParquetWorkerRequest,
  transferables: Transferable[] = [],
  options: PostRequestOptions = {}
): Promise<T> {
  const activeWorker = worker;
  if (!activeWorker) {
    return Promise.reject(new Error('Parquet worker is not enabled'));
  }
  const { signal } = options;
  if (signal?.aborted) {
    return Promise.reject(new DOMException('Aborted', 'AbortError'));
  }
  const id = ++nextRequestId;
  return new Promise<T>((resolve, reject) => {
    const entry: PendingRequest = {
      resolve: resolve as (value: unknown) => void,
      reject,
      deliveredChunk: false,
      ...(options.onChunk ? { onChunk: options.onChunk } : {}),
    };
    pending.set(id, entry);
    if (signal) {
      const onAbort = () => {
        const aborted = settlePending(id);
        if (!aborted) {
          return;
        }
        if (aborted.onChunk) {
          cancelWorkerStream(id);
        }
        aborted.reject(new DOMException('Aborted', 'AbortError'));
      };
      signal.addEventListener('abort', onAbort, { once: true });
      entry.removeAbortListener = () => {
        signal.removeEventListener('abort', onAbort);
      };
    }
    armTimeout(id);
    const message: ParquetWorkerMessage = { id, direction: 'request', request };
    if (transferables.length > 0) {
      activeWorker.postMessage(message, transferables);
    } else {
      activeWorker.postMessage(message);
    }
  });
}

export function transferablesForParquetPayload(
  parts?: Uint8Array[],
  rowGroups?: ParquetRowGroupBytesChunk[]
): Transferable[] {
  const transferables: Transferable[] = [];
  if (parts) {
    for (const part of parts) {
      transferables.push(part.buffer);
    }
  }
  if (rowGroups) {
    for (const chunk of rowGroups) {
      transferables.push(chunk.schemaBytes.buffer, chunk.rowGroupBytes.buffer);
    }
  }
  return transferables;
}

function transferablesForRequest(request: ParquetWorkerRequest): Transferable[] {
  switch (request.type) {
    case 'decodeParquetRowFeatureCodes':
    case 'scanParquetFeatureCounts':
    case 'decodeParquetGeometryCapped':
    case 'decodeGeometryWithFeatures':
    case 'scanParquetByFeatureCodes':
    case 'scanParquetFeatureCatalog':
      return transferablesForParquetPayload(request.parts, request.rowGroups);
    case 'scanMortonRowGroupsInBounds':
      return transferablesForParquetPayload(undefined, request.rowGroups);
    case 'decodeShapesGeometry':
      return transferablesForParquetPayload(request.parts);
  }
  return [];
}

export type EnableParquetWorkerOptions = {
  /**
   * Where the worker bundle lives, from an import your bundler resolves. In Vite:
   * `import workerUrl from '@spatialdata/core/parquet-worker?worker&url'`.
   *
   * Omit only when core is loaded as published ESM without being re-bundled — a dev
   * server, an import map, a CDN — where `dist/parquet-worker.js` really does sit
   * next to the chunk asking for it.
   */
  workerUrl?: string | URL;
  /**
   * Build the Worker yourself, for bundlers that cannot hand back a URL for a
   * *bundled* worker. webpack is the case this exists for: it only builds a worker
   * when it can see the `new Worker(new URL(...))` form literally, and only when that
   * URL points at a file in your own source.
   *
   * ```ts
   * // parquetWorkerEntry.ts — one line, in YOUR source tree
   * import '@spatialdata/core/parquet-worker';
   * ```
   *
   * ```ts
   * enableParquetWorker({
   *   createWorker: () =>
   *     new Worker(new URL('./parquetWorkerEntry.ts', import.meta.url), {
   *       type: 'module',
   *     }),
   * });
   * ```
   *
   * The local file is not ceremony. Pointing the URL straight at the bare specifier —
   * `new URL('@spatialdata/core/parquet-worker', import.meta.url)` — resolves to this
   * package's published `dist/parquet-worker.js` and makes webpack emit *that file* as
   * a static asset, still carrying its relative imports to sibling chunks and a bare
   * `apache-arrow`: 9kB whose every import 404s. Measured, not theorised.
   *
   * A factory rather than a `Worker`, because enabling tears down and rebuilds: an
   * instance could only be used once. Takes precedence over {@link workerUrl}.
   */
  createWorker?: () => Worker;
};

/**
 * The published `dist/parquet-worker.js`, resolved at runtime — correct wherever core
 * is loaded as published ESM (dev server, import map, CDN). A bundled application
 * must pass `workerUrl` instead; see {@link enableParquetWorker}.
 *
 * Both details here were measured. `@vite-ignore` stays: without it *this* package's
 * lib build resolves the URL and bakes an absolute `/assets/parquet-worker-<hash>.js`
 * into the published chunk. And the filename stays a literal rather than the variable
 * `zarrextra/workers` hides its worker name behind (docs/worker-bundling): that trick
 * makes a consumer emit the published file as a *static asset*, which only works for
 * a self-contained worker. This one imports sibling chunks and bare `apache-arrow`,
 * so it emitted 11.5kB whose every import 404s.
 */
function defaultWorkerUrl(): URL | undefined {
  // `import.meta` is replaced with `{}` in this package's CJS output, so there is no
  // base to resolve against and `new URL(x, undefined)` throws `Invalid URL`. A CJS
  // host has to pass `workerUrl` or `createWorker`; say so rather than throw.
  // Read through `unknown` rather than asserting a shape: the cjs build replaces
  // `import.meta` with `{}`, so this genuinely may not be a string at runtime and the
  // type should say so rather than be talked out of it.
  const base: unknown = import.meta.url;
  if (typeof base !== 'string') {
    return undefined;
  }
  return new URL(/* @vite-ignore */ './parquet-worker.js', base);
}

export function isParquetWorkerEnabled(): boolean {
  return enabled && worker !== undefined;
}

/**
 * Start the parquet worker, moving parquet decodes and scans off the main thread.
 *
 * A bundled application passes `workerUrl`, and the import that produces it is what
 * makes the worker part of that build — including the parquet-wasm the worker loads
 * on its own side. In Vite:
 *
 * ```ts
 * import workerUrl from '@spatialdata/core/parquet-worker?worker&url';
 * enableParquetWorker({ workerUrl });
 * ```
 *
 * Omit it only where core is not re-bundled; see {@link defaultWorkerUrl}.
 *
 * A worker that fails to load is switched off rather than left to time out, so a bad
 * URL costs performance, not correctness — except for
 * `loadPointsMatchingFeatureCodes`, which has no main-thread fallback and throws.
 * Gate any UI for it on {@link isParquetWorkerEnabled}.
 */
export function enableParquetWorker(options: EnableParquetWorkerOptions = {}) {
  if (typeof Worker === 'undefined') {
    return;
  }
  if (worker) {
    disableParquetWorker();
  }
  // A fresh attempt, even after a dead worker latched `ensureParquetWorker` off.
  startupFailed = false;
  workerHasAnswered = false;
  // Constructing a Worker can throw synchronously — a `createWorker` factory is host
  // code, and `new Worker` itself throws on a URL the browser rejects or a CSP that
  // forbids it. Everything else here treats a bad worker as a performance cost rather
  // than a failure, and a throw would break that promise by taking out the caller's
  // render instead. Degrade the same way a dead worker does.
  try {
    if (options.createWorker) {
      worker = options.createWorker();
    } else if (options.workerUrl) {
      worker = new Worker(options.workerUrl, { type: 'module' });
    } else {
      const url = defaultWorkerUrl();
      if (!url) {
        startupFailed = true;
        console.warn(
          '[@spatialdata/core] no default parquet worker URL is available in a CommonJS ' +
            'build; pass enableParquetWorker({ workerUrl }) or ({ createWorker }). ' +
            'Continuing on the main thread.'
        );
        return;
      }
      worker = new Worker(url, { type: 'module' });
    }
  } catch (error) {
    worker = undefined;
    enabled = false;
    startupFailed = true;
    console.warn(
      `[@spatialdata/core] parquet worker could not be constructed (${
        error instanceof Error ? error.message : String(error)
      }); continuing on the main thread.`
    );
    return;
  }
  ensureWorkerListener();
  enabled = true;
}

/** Fail every in-flight request with the same reason. */
function rejectAllPending(reason: Error) {
  for (const [id] of [...pending]) {
    settlePending(id)?.reject(reason);
  }
}

export function disableParquetWorker(reason?: Error) {
  enabled = false;
  // Teardown forgets what was learned about the worker that just went away.
  startupFailed = false;
  workerHasAnswered = false;
  if (worker) {
    worker.terminate();
    worker = undefined;
  }
  rejectAllPending(reason ?? new Error('Parquet worker disabled'));
}

export function setParquetWorkerDefaultEnabled(value: boolean) {
  defaultEnabled = value;
}

export function ensureParquetWorker(options: EnableParquetWorkerOptions = {}) {
  if (!enabled && defaultEnabled && !startupFailed) {
    enableParquetWorker(options);
  }
}

export async function filterColumnarByFeatureCodesInWorker(
  data: PointsColumnarData,
  featureCodes: readonly number[] | undefined,
  sourceFeatureCodes: ArrayLike<number>
): Promise<PointsColumnarData> {
  ensureParquetWorker();
  if (!isParquetWorkerEnabled()) {
    const { filterColumnarByFeatureCodes } = await import('../pointsTiling.js');
    return filterColumnarByFeatureCodes(data, featureCodes, sourceFeatureCodes);
  }

  const xs =
    data.data[0] instanceof Float32Array
      ? data.data[0]
      : Float32Array.from(data.data[0] as ArrayLike<number>);
  const ys =
    data.data[1] instanceof Float32Array
      ? data.data[1]
      : Float32Array.from(data.data[1] as ArrayLike<number>);
  const zs = data.data[2]
    ? data.data[2] instanceof Float32Array
      ? data.data[2]
      : Float32Array.from(data.data[2] as ArrayLike<number>)
    : undefined;

  const result = await postRequest<Extract<ParquetWorkerResponse, { ok: true }>['result']>({
    type: 'filterColumnarByFeatureCodes',
    xs,
    ys,
    zs,
    featureCodes,
    sourceFeatureCodes,
  });

  if (result.kind !== 'columnar') {
    throw new Error('Unexpected parquet worker response for filterColumnarByFeatureCodes');
  }
  return columnarDataFromWorkerResult(result);
}

export type DecodeParquetRowFeatureCodesInput = {
  parts?: Uint8Array[];
  rowGroups?: ParquetRowGroupBytesChunk[];
  columns: string[];
  maxRows?: number;
  featureKey: string;
  featureCodeColumnName?: string;
  featureCodeEntries?: ReadonlyArray<{ name: string; code: number }>;
};

export async function decodeParquetRowFeatureCodesInWorker(
  input: DecodeParquetRowFeatureCodesInput
): Promise<Int32Array | null> {
  ensureParquetWorker();
  if (!isParquetWorkerEnabled()) {
    return null;
  }
  if (!input.parts?.length && !input.rowGroups?.length) {
    return null;
  }
  if (input.parts?.length && input.rowGroups?.length) {
    throw new Error('decodeParquetRowFeatureCodesInWorker requires parts or rowGroups, not both');
  }
  const request: Extract<ParquetWorkerRequest, { type: 'decodeParquetRowFeatureCodes' }> = {
    type: 'decodeParquetRowFeatureCodes',
    ...input,
  };
  const result = await postRequest<Extract<ParquetWorkerResponse, { ok: true }>['result']>(
    request,
    transferablesForRequest(request)
  );
  if (result.kind !== 'rowFeatureCodes') {
    throw new Error('Unexpected parquet worker response for decodeParquetRowFeatureCodes');
  }
  return result.codes;
}

export type ScanParquetFeatureCatalogInput = {
  rowGroups?: ParquetRowGroupBytesChunk[];
  parts: Uint8Array[];
  columns: string[];
  featureKey: string;
  featureCodeColumnName?: string;
  skipMortonSentinels?: boolean;
};

export async function scanParquetFeatureCatalogInWorker(
  input: ScanParquetFeatureCatalogInput
): Promise<PointsFeatureCatalog | null> {
  ensureParquetWorker();
  if (!isParquetWorkerEnabled() || input.parts.length === 0) {
    return null;
  }
  const request: Extract<ParquetWorkerRequest, { type: 'scanParquetFeatureCatalog' }> = {
    type: 'scanParquetFeatureCatalog',
    ...input,
  };
  const result = await postRequest<Extract<ParquetWorkerResponse, { ok: true }>['result']>(
    request,
    transferablesForRequest(request)
  );
  if (result.kind !== 'catalog') {
    throw new Error('Unexpected parquet worker response for scanParquetFeatureCatalog');
  }
  return result.catalog;
}

export type DecodeParquetGeometryCappedInput = ParquetWorkerPayload & {
  axisNames: string[];
  columns: string[];
  maxRows: number;
  featureKey?: string;
  featureCodeColumnName?: string;
  featureCodeEntries?: ReadonlyArray<{ name: string; code: number }>;
};

export async function decodeParquetGeometryCappedInWorker(
  input: DecodeParquetGeometryCappedInput
): Promise<{
  shape: number[];
  data: ArrayLike<number>[];
  featureCodes?: Int32Array;
} | null> {
  ensureParquetWorker();
  if (!isParquetWorkerEnabled()) {
    return null;
  }
  if (!input.parts?.length && !input.rowGroups?.length) {
    return null;
  }
  if (input.parts?.length && input.rowGroups?.length) {
    throw new Error('decodeParquetGeometryCappedInWorker requires parts or rowGroups, not both');
  }
  const request: Extract<ParquetWorkerRequest, { type: 'decodeParquetGeometryCapped' }> = {
    type: 'decodeParquetGeometryCapped',
    ...input,
  };
  const result = await postRequest<Extract<ParquetWorkerResponse, { ok: true }>['result']>(
    request,
    transferablesForRequest(request)
  );
  if (result.kind !== 'columnar') {
    throw new Error('Unexpected parquet worker response for decodeParquetGeometryCapped');
  }
  const data = result.zs ? [result.xs, result.ys, result.zs] : [result.xs, result.ys];
  return {
    shape: result.shape,
    data,
    featureCodes: result.featureCodes,
  };
}

export type DecodeGeometryWithFeaturesInput = ParquetWorkerPayload & {
  axisNames: string[];
  columns: string[];
  maxRows?: number;
  featureKey: string;
  featureCodeColumnName?: string;
};

/**
 * Off-thread codes-with-geometry preload: decode geometry + per-row feature
 * codes + the feature catalog from one projected decode in the worker. The
 * caller fetches whole row-group (or part) bytes via async range reads, so the
 * CPU-heavy decode never blocks the main thread. Returns null when the worker is
 * disabled or the payload is empty (caller falls back to the main-thread decode).
 */
export async function decodeGeometryWithFeaturesInWorker(
  input: DecodeGeometryWithFeaturesInput
): Promise<{
  shape: number[];
  data: ArrayLike<number>[];
  featureCodes?: Int32Array;
  featureCatalog?: PointsFeatureCatalog;
} | null> {
  ensureParquetWorker();
  if (!isParquetWorkerEnabled()) {
    return null;
  }
  if (!input.parts?.length && !input.rowGroups?.length) {
    return null;
  }
  if (input.parts?.length && input.rowGroups?.length) {
    throw new Error('decodeGeometryWithFeaturesInWorker requires parts or rowGroups, not both');
  }
  const request: Extract<ParquetWorkerRequest, { type: 'decodeGeometryWithFeatures' }> = {
    type: 'decodeGeometryWithFeatures',
    ...input,
  };
  const result = await postRequest<Extract<ParquetWorkerResponse, { ok: true }>['result']>(
    request,
    transferablesForRequest(request)
  );
  if (result.kind !== 'geometryWithFeatures') {
    throw new Error('Unexpected parquet worker response for decodeGeometryWithFeatures');
  }
  const data = result.zs ? [result.xs, result.ys, result.zs] : [result.xs, result.ys];
  return {
    shape: result.shape,
    data,
    ...(result.featureCodes ? { featureCodes: result.featureCodes } : {}),
    ...(result.featureCatalog ? { featureCatalog: result.featureCatalog } : {}),
  };
}

export type StreamGeometryWithFeaturesInput = {
  /**
   * Range-readable absolute URLs for the dataset's parts, in order. The CALLER
   * establishes that they are servable (`canStreamParquetByUrl` plus a
   * `serverSupportsStreamingRanges` probe per origin) — the worker cannot probe
   * cheaply, and the reader panics rather than erroring on a refused range.
   */
  partUrls: string[];
  axisNames: string[];
  featureKey: string;
  maxRows: number;
  batchSize: number;
  /** Superseded load: cancels the worker's fetching, not just our listening. */
  signal?: AbortSignal;
};

export type StreamGeometryWithFeaturesEnd = {
  /** Rows emitted across every batch — what the caller should have accumulated. */
  rows: number;
  /** False when a part's projection lacked the feature column; rows are uncoloured. */
  sawFeatureColumn: boolean;
};

/**
 * Progressive geometry+colour preload, decoded ENTIRELY in the worker.
 *
 * The worker range-fetches each part itself and posts batches back as it decodes
 * them, so the main thread's only per-batch work is copying the batch into its
 * accumulator. That is the point: the equivalent main-thread stream
 * (`VPointsSource.streamPointsWithFeaturesByUrl`) keeps the progressive paint but
 * does the parquet decode on the UI thread, which is where a 4M-row Xenium
 * element's tens of seconds of long tasks come from.
 *
 * Returns null when the worker is off or there is nothing to read, matching the
 * other `*InWorker` helpers — the caller falls through to the main-thread stream.
 *
 * ON FAILURE it REJECTS, even when batches were already delivered and painted.
 * There is no partial-success return, deliberately: a truncated preload is
 * indistinguishable to every downstream consumer from a complete one (they read
 * `preloadTruncated` and the row cap, not "how far did the stream get"), so
 * reporting one as success would silently drop points and skew the per-feature
 * tallies. Rejecting sends the caller to the main-thread stream, which restarts
 * from row 0 and re-paints over the partial — the worst case is the cost this
 * whole path exists to avoid, which is exactly the status quo it replaced.
 *
 * Batches already handed to `onBatch` are therefore not a commitment. They are
 * safe to have painted: each progress tick carries the catalog matching its own
 * codes, so a later tick from a different code space is reconciled by the same
 * `remapRowFeatureCodes` handoff that already spans preload and full scan.
 */
export async function streamGeometryWithFeaturesInWorker(
  input: StreamGeometryWithFeaturesInput,
  onBatch: (chunk: ParquetWorkerStreamChunk) => void
): Promise<StreamGeometryWithFeaturesEnd | null> {
  ensureParquetWorker();
  if (!isParquetWorkerEnabled()) {
    return null;
  }
  if (input.partUrls.length === 0 || input.maxRows <= 0) {
    return null;
  }
  const { signal, ...rest } = input;
  const request: Extract<ParquetWorkerRequest, { type: 'streamGeometryWithFeatures' }> = {
    type: 'streamGeometryWithFeatures',
    ...rest,
  };
  const result = await postRequest<Extract<ParquetWorkerResponse, { ok: true }>['result']>(
    request,
    [],
    { onChunk: onBatch, ...(signal ? { signal } : {}) }
  );
  if (result.kind !== 'geometryWithFeaturesStreamEnd') {
    throw new Error('Unexpected parquet worker response for streamGeometryWithFeatures');
  }
  return { rows: result.rows, sawFeatureColumn: result.sawFeatureColumn };
}

export type DecodeShapesGeometryInput = {
  parts: Uint8Array[];
  geometryColumnName: string;
  geometryKind: 'polygon' | 'circle' | 'point';
};

/**
 * Off-thread shapes geometry decode: parse the WKB geometry column into flat
 * transferable buffers in the worker, so the CPU-heavy WKB parse never blocks the
 * main thread. Returns `null` when the worker is disabled or there are no bytes —
 * the caller falls back to the identical main-thread decode.
 */
export async function decodeShapesGeometryInWorker(
  input: DecodeShapesGeometryInput
): Promise<FlatShapeGeometry | null> {
  ensureParquetWorker();
  if (!isParquetWorkerEnabled() || input.parts.length === 0) {
    return null;
  }
  const request: Extract<ParquetWorkerRequest, { type: 'decodeShapesGeometry' }> = {
    type: 'decodeShapesGeometry',
    ...input,
  };
  const result = await postRequest<Extract<ParquetWorkerResponse, { ok: true }>['result']>(
    request,
    transferablesForRequest(request)
  );
  if (result.kind === 'shapesGeometryPolygon') {
    return {
      kind: 'polygon',
      positions: result.positions,
      startIndices: result.startIndices,
      featureCount: result.featureCount,
      tessellation: result.tessellation,
    };
  }
  if (result.kind === 'shapesGeometryPoint') {
    return { kind: 'point', xs: result.xs, ys: result.ys, featureCount: result.featureCount };
  }
  throw new Error('Unexpected parquet worker response for decodeShapesGeometry');
}

export async function countFeatureCodesInWorker(
  sourceFeatureCodes: ArrayLike<number>
): Promise<Map<number, number>> {
  ensureParquetWorker();
  if (!isParquetWorkerEnabled()) {
    const { countFeatureCodesHistogram } = await import('../pointsFeatures.js');
    return countFeatureCodesHistogram(sourceFeatureCodes);
  }
  const codesArray =
    sourceFeatureCodes instanceof Int32Array
      ? sourceFeatureCodes
      : Int32Array.from(sourceFeatureCodes);
  const result = await postRequest<Extract<ParquetWorkerResponse, { ok: true }>['result']>({
    type: 'countFeatureCodes',
    sourceFeatureCodes: codesArray,
  });
  if (result.kind !== 'featureCounts') {
    throw new Error('Unexpected parquet worker response for countFeatureCodes');
  }
  const counts = new Map<number, number>();
  for (let index = 0; index < result.codes.length; index += 1) {
    counts.set(result.codes[index], result.counts[index]);
  }
  return counts;
}

export type ScanParquetFeatureCountsInput = ParquetWorkerPayload & {
  featureKey: string;
  featureCodeColumnName?: string;
};

export async function scanParquetFeatureCountsInWorker(
  input: ScanParquetFeatureCountsInput
): Promise<Map<number, number> | null> {
  ensureParquetWorker();
  if (!isParquetWorkerEnabled()) {
    return null;
  }
  if (!input.parts?.length && !input.rowGroups?.length) {
    return null;
  }
  const request: Extract<ParquetWorkerRequest, { type: 'scanParquetFeatureCounts' }> = {
    type: 'scanParquetFeatureCounts',
    ...input,
  };
  const result = await postRequest<Extract<ParquetWorkerResponse, { ok: true }>['result']>(
    request,
    transferablesForRequest(request)
  );
  if (result.kind !== 'featureCounts') {
    throw new Error('Unexpected parquet worker response for scanParquetFeatureCounts');
  }
  const counts = new Map<number, number>();
  for (let index = 0; index < result.codes.length; index += 1) {
    counts.set(result.codes[index], result.counts[index]);
  }
  return counts;
}

export type ScanParquetByFeatureCodesInput = ParquetWorkerPayload & {
  /** Stream variant: the worker fetches only the projected columns from this URL
   * (see the protocol type). Mutually exclusive with `parts`/`rowGroups`. */
  streamUrl?: string;
  streamRowGroups?: number[];
  streamColumns?: string[];
  axisNames: string[];
  featureKey: string;
  featureCodeColumnName?: string;
  featureCodes: readonly number[];
  memoryCap: number;
  /** Authoritative name→code entries for dict-only elements (no code column). */
  featureCodeEntries?: ReadonlyArray<{ name: string; code: number }>;
};

export async function scanParquetByFeatureCodesInWorker(
  input: ScanParquetByFeatureCodesInput
): Promise<{
  data: PointsColumnarData;
  matchedRows: number;
  scannedRows: number;
} | null> {
  ensureParquetWorker();
  if (!isParquetWorkerEnabled()) {
    return null;
  }
  if (!input.parts?.length && !input.rowGroups?.length && !input.streamUrl) {
    return null;
  }
  const request: Extract<ParquetWorkerRequest, { type: 'scanParquetByFeatureCodes' }> = {
    type: 'scanParquetByFeatureCodes',
    ...input,
  };
  const result = await postRequest<Extract<ParquetWorkerResponse, { ok: true }>['result']>(
    request,
    transferablesForRequest(request)
  );
  if (result.kind !== 'columnarScan') {
    throw new Error('Unexpected parquet worker response for scanParquetByFeatureCodes');
  }
  return {
    data: columnarDataFromWorkerResult(result),
    matchedRows: result.matchedRows,
    scannedRows: result.scannedRows,
  };
}

export type ScanMortonRowGroupsInBoundsInput = {
  rowGroups: ParquetRowGroupBytesChunk[];
  bounds: PointsBounds;
  axisNames: string[];
  mortonCodeColumnName: string;
  featureCodeColumnName?: string;
  featureCodes?: readonly number[];
};

export async function scanMortonRowGroupsInBoundsInWorker(
  input: ScanMortonRowGroupsInBoundsInput
): Promise<PointsColumnarData | null> {
  ensureParquetWorker();
  if (!isParquetWorkerEnabled() || input.rowGroups.length === 0) {
    return null;
  }
  const request: Extract<ParquetWorkerRequest, { type: 'scanMortonRowGroupsInBounds' }> = {
    type: 'scanMortonRowGroupsInBounds',
    ...input,
  };
  const result = await postRequest<Extract<ParquetWorkerResponse, { ok: true }>['result']>(
    request,
    transferablesForRequest(request)
  );
  if (result.kind !== 'columnar') {
    throw new Error('Unexpected parquet worker response for scanMortonRowGroupsInBounds');
  }
  return columnarDataFromWorkerResult(result);
}

export async function decodeParquetPartsInWorker(
  parts: Uint8Array[],
  columns?: string[],
  maxRows?: number
): Promise<ReturnType<typeof tableFromIPC>> {
  ensureParquetWorker();
  if (!isParquetWorkerEnabled()) {
    throw new Error('Parquet worker is required for decodeParquetPartsInWorker');
  }
  const result = await postRequest<Extract<ParquetWorkerResponse, { ok: true }>['result']>({
    type: 'decodeParquetParts',
    parts,
    columns,
    maxRows,
  });
  if (result.kind !== 'parquetTable') {
    throw new Error('Unexpected parquet worker response for decodeParquetParts');
  }
  return tableFromIPC(result.tableIpc);
}

export async function buildFeatureCatalogInWorker(
  featureKey: string,
  tableIpc: Uint8Array
): Promise<PointsFeatureCatalog> {
  ensureParquetWorker();
  if (!isParquetWorkerEnabled()) {
    throw new Error('Parquet worker is required for buildFeatureCatalogInWorker');
  }
  const result = await postRequest<Extract<ParquetWorkerResponse, { ok: true }>['result']>({
    type: 'buildFeatureCatalog',
    featureKey,
    tableIpc,
  });
  if (result.kind !== 'catalog') {
    throw new Error('Unexpected parquet worker response for buildFeatureCatalog');
  }
  return result.catalog;
}
