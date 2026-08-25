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
  type PointsBounds,
} from './parquetWorkerProtocol.js';

let worker: Worker | undefined;
let nextRequestId = 0;
const pending = new Map<
  number,
  {
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
    timeout?: ReturnType<typeof setTimeout>;
  }
>();

// Safety net: if the worker was enabled but is not functionally wired (e.g. a
// host points enableParquetWorker() at a URL that loads but whose module never
// posts a response), a request would otherwise await forever. After this budget
// with no reply we reject the request so the caller falls back to the main
// thread (every *InWorker helper is wrapped in a try/catch fallback). Generous
// by default because a working worker legitimately spends many seconds decoding
// large parquet; the timeout is meant to catch a *silent* worker, not a slow one.
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
  pending.delete(id);
  return entry;
}

/**
 * Whether this worker has ever answered — the test for "did it actually load?".
 *
 * A module worker whose URL 404s fires one `error` event and then stays silent,
 * so without this every subsequent request would sit until its timeout while
 * `isParquetWorkerEnabled()` kept claiming the worker was there. Distinguishing
 * a dead-on-arrival worker from one that threw mid-request matters: the first is
 * a wiring mistake and the worker should be given up on, the second is one bad
 * request and the worker is probably still usable.
 */
let workerHasAnswered = false;
/**
 * Latch: a worker built from the default URL failed to load, so stop rebuilding it.
 *
 * Only `ensureParquetWorker` respects this — an explicit `enableParquetWorker()`
 * clears it, because the caller is presumably passing a different `workerUrl`.
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
      // A live worker threw. Reject what is in flight; every `*InWorker` helper
      // falls back to the main thread on rejection, and the next request gets to
      // try the worker again.
      rejectAllPending(new Error(detail));
      return;
    }
    // Never answered, so it never loaded — almost always a `workerUrl` that does
    // not resolve to the published bundle. Give up on it rather than leave
    // `isParquetWorkerEnabled()` returning true for a worker that cannot reply:
    // callers with a main-thread fallback take it, and the one caller without a
    // fallback (the feature-index scan) fails immediately with a real reason
    // instead of hanging to its timeout.
    disableParquetWorker(
      new Error(
        `Parquet worker failed to start (${detail}); falling back to the main thread. ` +
          'If the worker bundle is not served next to @spatialdata/core, pass its URL: ' +
          'enableParquetWorker({ workerUrl }).'
      )
    );
    // After the disable, which clears the latch as an explicit teardown should.
    startupFailed = true;
    console.warn(
      `[@spatialdata/core] parquet worker failed to start (${detail}); ` +
        'continuing on the main thread. Pass enableParquetWorker({ workerUrl }) with a ' +
        'bundler-resolved URL for @spatialdata/core/parquet-worker.'
    );
  };
}

function postRequest<T>(
  request: ParquetWorkerRequest,
  transferables: Transferable[] = []
): Promise<T> {
  const activeWorker = worker;
  if (!activeWorker) {
    return Promise.reject(new Error('Parquet worker is not enabled'));
  }
  const id = ++nextRequestId;
  return new Promise<T>((resolve, reject) => {
    const entry: {
      resolve: (value: unknown) => void;
      reject: (error: Error) => void;
      timeout?: ReturnType<typeof setTimeout>;
    } = { resolve: resolve as (value: unknown) => void, reject };
    if (requestTimeoutMs > 0 && Number.isFinite(requestTimeoutMs)) {
      entry.timeout = setTimeout(() => {
        settlePending(id)?.reject(
          new Error(
            `Parquet worker did not respond within ${requestTimeoutMs}ms; falling back to the main thread`
          )
        );
      }, requestTimeoutMs);
    }
    pending.set(id, entry);
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

/**
 * The published worker bundle, `dist/parquet-worker.js`, resolved at runtime.
 *
 * Correct wherever core is loaded as published ESM without being re-bundled — a dev
 * server, an import map, a CDN — because `dist/parquet-worker.js` really does sit
 * next to the chunk this runs in. A bundled application must pass `workerUrl`
 * instead; see {@link enableParquetWorker}.
 *
 * Two things here are deliberate, both measured rather than assumed:
 *
 * `@vite-ignore` stays. Without it, *this package's* lib build resolves the URL,
 * emits its own copy of the worker, and bakes an absolute
 * `/assets/parquet-worker-<hash>.js` into the published chunk — a path that exists
 * in no consumer's application.
 *
 * And the filename stays a literal, rather than the variable that
 * `zarrextra/workers` hides its codec-worker name behind (docs/worker-bundling).
 * That trick makes a consumer's bundler emit the published worker file as a static
 * asset, which works only for a *self-contained* worker. This one is not: the built
 * `parquet-worker.js` imports sibling chunks and bare `apache-arrow`, and copying it
 * as an asset produced an 11.5kB file whose every import 404s. Making it
 * self-contained would mean inlining the 6.6MB parquet-wasm into it. So a bundled
 * consumer needs its bundler to *build* the worker — `?worker&url` in Vite — and the
 * honest default here is the runtime-relative URL, plus the startup detection above
 * that turns a wrong guess into a main-thread fallback instead of a hang.
 */
function defaultWorkerUrl(): URL {
  return new URL(/* @vite-ignore */ './parquet-worker.js', import.meta.url);
}

export function isParquetWorkerEnabled(): boolean {
  return enabled && worker !== undefined;
}

/**
 * Start the parquet worker, moving parquet decodes and scans off the main thread.
 *
 * A bundled application passes `workerUrl`, and the import that produces it is what
 * makes the worker part of that application's build — including the parquet-wasm the
 * worker loads on its own side. In Vite:
 *
 * ```ts
 * import workerUrl from '@spatialdata/core/parquet-worker?worker&url';
 * enableParquetWorker({ workerUrl });
 * ```
 *
 * Omit it only where core is loaded as published ESM without being re-bundled (a dev
 * server, an import map, a CDN); see {@link defaultWorkerUrl}.
 *
 * A worker that fails to load is detected and switched off rather than left to time
 * out, so a broken URL costs performance, not correctness — with one exception:
 * `loadPointsMatchingFeatureCodes` (the feature-index scan) has no main-thread
 * fallback and will throw. Gate any UI for it on {@link isParquetWorkerEnabled}.
 */
export function enableParquetWorker(options: { workerUrl?: string | URL } = {}) {
  if (typeof Worker === 'undefined') {
    return;
  }
  if (worker) {
    disableParquetWorker();
  }
  // An explicit call is a fresh attempt, even after a dead-on-arrival worker
  // latched `ensureParquetWorker` off — the caller is presumably passing a URL
  // that resolves this time.
  startupFailed = false;
  workerHasAnswered = false;
  if (options.workerUrl) {
    worker = new Worker(options.workerUrl, { type: 'module' });
  } else {
    worker = new Worker(defaultWorkerUrl(), { type: 'module' });
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
  // Teardown forgets everything learned about the worker that just went away; the
  // startup-failure handler re-latches after calling this.
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

export function ensureParquetWorker(options: { workerUrl?: string | URL } = {}) {
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
