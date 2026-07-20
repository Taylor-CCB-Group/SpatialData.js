import { tableFromIPC } from 'apache-arrow';
import type { PointsFeatureCatalog } from '../pointsTiling.js';
import type { FlatShapeGeometry } from '../shapesGeometryDecode.js';
import type { PointsColumnarData } from '../spatialViewFit.js';
import {
  columnarDataFromWorkerResult,
  type ParquetRowGroupBytesChunk,
  type ParquetWorkerPayload,
  type PointsBounds,
  type PointsWorkerMessage,
  type PointsWorkerRequest,
  type PointsWorkerResponse,
} from './pointsWorkerProtocol.js';

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
// host points enablePointsWorker() at a URL that loads but whose module never
// posts a response), a request would otherwise await forever. After this budget
// with no reply we reject the request so the caller falls back to the main
// thread (every *InWorker helper is wrapped in a try/catch fallback). Generous
// by default because a working worker legitimately spends many seconds decoding
// large parquet; the timeout is meant to catch a *silent* worker, not a slow one.
let requestTimeoutMs = 30_000;

/** Override the per-request worker timeout (ms). Set to 0/Infinity to disable. */
export function setPointsWorkerRequestTimeout(ms: number) {
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

let enabled = false;
// Points worker is opt-in: hosts call enablePointsWorker() (or
// setPointsWorkerDefaultEnabled(true)) once they have wired the worker bundle.
// Auto-enabling in every browser caused loadPoints() to hang forever wherever
// the worker isn't functionally wired (e.g. Vite dev serving core from source),
// because the worker branch awaits a response that never arrives and the
// main-thread fallback only triggers on a rejection, not a stuck promise.
let defaultEnabled = false;

function ensureWorkerListener() {
  if (!worker) {
    return;
  }
  worker.onmessage = (event: MessageEvent<PointsWorkerMessage>) => {
    const message = event.data;
    if (message.direction !== 'response') {
      return;
    }
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
    for (const [id] of [...pending]) {
      settlePending(id)?.reject(new Error(event.message || 'Points worker error'));
    }
  };
}

function postRequest<T>(
  request: PointsWorkerRequest,
  transferables: Transferable[] = []
): Promise<T> {
  const activeWorker = worker;
  if (!activeWorker) {
    return Promise.reject(new Error('Points worker is not enabled'));
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
            `Points worker did not respond within ${requestTimeoutMs}ms; falling back to the main thread`
          )
        );
      }, requestTimeoutMs);
    }
    pending.set(id, entry);
    const message: PointsWorkerMessage = { id, direction: 'request', request };
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

function transferablesForRequest(request: PointsWorkerRequest): Transferable[] {
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

export function isPointsWorkerEnabled(): boolean {
  return enabled && worker !== undefined;
}

export function enablePointsWorker(options: { workerUrl?: string | URL } = {}) {
  if (typeof Worker === 'undefined') {
    return;
  }
  if (worker) {
    disablePointsWorker();
  }
  if (options.workerUrl) {
    worker = new Worker(options.workerUrl, { type: 'module' });
  } else {
    // Inline URL so Vite dev apps can bundle the worker; @vite-ignore keeps lib build
    // emitting a runtime relative URL to dist/points-worker.js (not /assets/...).
    worker = new Worker(new URL(/* @vite-ignore */ './points-worker.js', import.meta.url), {
      type: 'module',
    });
  }
  ensureWorkerListener();
  enabled = true;
}

export function disablePointsWorker() {
  enabled = false;
  if (worker) {
    worker.terminate();
    worker = undefined;
  }
  for (const [id] of [...pending]) {
    settlePending(id)?.reject(new Error('Points worker disabled'));
  }
}

export function setPointsWorkerDefaultEnabled(value: boolean) {
  defaultEnabled = value;
}

export function ensurePointsWorker(options: { workerUrl?: string | URL } = {}) {
  if (!enabled && defaultEnabled) {
    enablePointsWorker(options);
  }
}

export async function filterColumnarByFeatureCodesInWorker(
  data: PointsColumnarData,
  featureCodes: readonly number[] | undefined,
  sourceFeatureCodes: ArrayLike<number>
): Promise<PointsColumnarData> {
  ensurePointsWorker();
  if (!isPointsWorkerEnabled()) {
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

  const result = await postRequest<Extract<PointsWorkerResponse, { ok: true }>['result']>({
    type: 'filterColumnarByFeatureCodes',
    xs,
    ys,
    zs,
    featureCodes,
    sourceFeatureCodes,
  });

  if (result.kind !== 'columnar') {
    throw new Error('Unexpected points worker response for filterColumnarByFeatureCodes');
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
  ensurePointsWorker();
  if (!isPointsWorkerEnabled()) {
    return null;
  }
  if (!input.parts?.length && !input.rowGroups?.length) {
    return null;
  }
  if (input.parts?.length && input.rowGroups?.length) {
    throw new Error('decodeParquetRowFeatureCodesInWorker requires parts or rowGroups, not both');
  }
  const request: Extract<PointsWorkerRequest, { type: 'decodeParquetRowFeatureCodes' }> = {
    type: 'decodeParquetRowFeatureCodes',
    ...input,
  };
  const result = await postRequest<Extract<PointsWorkerResponse, { ok: true }>['result']>(
    request,
    transferablesForRequest(request)
  );
  if (result.kind !== 'rowFeatureCodes') {
    throw new Error('Unexpected points worker response for decodeParquetRowFeatureCodes');
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
  ensurePointsWorker();
  if (!isPointsWorkerEnabled() || input.parts.length === 0) {
    return null;
  }
  const request: Extract<PointsWorkerRequest, { type: 'scanParquetFeatureCatalog' }> = {
    type: 'scanParquetFeatureCatalog',
    ...input,
  };
  const result = await postRequest<Extract<PointsWorkerResponse, { ok: true }>['result']>(
    request,
    transferablesForRequest(request)
  );
  if (result.kind !== 'catalog') {
    throw new Error('Unexpected points worker response for scanParquetFeatureCatalog');
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
  ensurePointsWorker();
  if (!isPointsWorkerEnabled()) {
    return null;
  }
  if (!input.parts?.length && !input.rowGroups?.length) {
    return null;
  }
  if (input.parts?.length && input.rowGroups?.length) {
    throw new Error('decodeParquetGeometryCappedInWorker requires parts or rowGroups, not both');
  }
  const request: Extract<PointsWorkerRequest, { type: 'decodeParquetGeometryCapped' }> = {
    type: 'decodeParquetGeometryCapped',
    ...input,
  };
  const result = await postRequest<Extract<PointsWorkerResponse, { ok: true }>['result']>(
    request,
    transferablesForRequest(request)
  );
  if (result.kind !== 'columnar') {
    throw new Error('Unexpected points worker response for decodeParquetGeometryCapped');
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
  ensurePointsWorker();
  if (!isPointsWorkerEnabled()) {
    return null;
  }
  if (!input.parts?.length && !input.rowGroups?.length) {
    return null;
  }
  if (input.parts?.length && input.rowGroups?.length) {
    throw new Error('decodeGeometryWithFeaturesInWorker requires parts or rowGroups, not both');
  }
  const request: Extract<PointsWorkerRequest, { type: 'decodeGeometryWithFeatures' }> = {
    type: 'decodeGeometryWithFeatures',
    ...input,
  };
  const result = await postRequest<Extract<PointsWorkerResponse, { ok: true }>['result']>(
    request,
    transferablesForRequest(request)
  );
  if (result.kind !== 'geometryWithFeatures') {
    throw new Error('Unexpected points worker response for decodeGeometryWithFeatures');
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
  ensurePointsWorker();
  if (!isPointsWorkerEnabled() || input.parts.length === 0) {
    return null;
  }
  const request: Extract<PointsWorkerRequest, { type: 'decodeShapesGeometry' }> = {
    type: 'decodeShapesGeometry',
    ...input,
  };
  const result = await postRequest<Extract<PointsWorkerResponse, { ok: true }>['result']>(
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
  throw new Error('Unexpected points worker response for decodeShapesGeometry');
}

export async function countFeatureCodesInWorker(
  sourceFeatureCodes: ArrayLike<number>
): Promise<Map<number, number>> {
  ensurePointsWorker();
  if (!isPointsWorkerEnabled()) {
    const { countFeatureCodesHistogram } = await import('../pointsFeatures.js');
    return countFeatureCodesHistogram(sourceFeatureCodes);
  }
  const codesArray =
    sourceFeatureCodes instanceof Int32Array
      ? sourceFeatureCodes
      : Int32Array.from(sourceFeatureCodes);
  const result = await postRequest<Extract<PointsWorkerResponse, { ok: true }>['result']>({
    type: 'countFeatureCodes',
    sourceFeatureCodes: codesArray,
  });
  if (result.kind !== 'featureCounts') {
    throw new Error('Unexpected points worker response for countFeatureCodes');
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
  ensurePointsWorker();
  if (!isPointsWorkerEnabled()) {
    return null;
  }
  if (!input.parts?.length && !input.rowGroups?.length) {
    return null;
  }
  const request: Extract<PointsWorkerRequest, { type: 'scanParquetFeatureCounts' }> = {
    type: 'scanParquetFeatureCounts',
    ...input,
  };
  const result = await postRequest<Extract<PointsWorkerResponse, { ok: true }>['result']>(
    request,
    transferablesForRequest(request)
  );
  if (result.kind !== 'featureCounts') {
    throw new Error('Unexpected points worker response for scanParquetFeatureCounts');
  }
  const counts = new Map<number, number>();
  for (let index = 0; index < result.codes.length; index += 1) {
    counts.set(result.codes[index], result.counts[index]);
  }
  return counts;
}

export type ScanParquetByFeatureCodesInput = ParquetWorkerPayload & {
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
  ensurePointsWorker();
  if (!isPointsWorkerEnabled()) {
    return null;
  }
  if (!input.parts?.length && !input.rowGroups?.length) {
    return null;
  }
  const request: Extract<PointsWorkerRequest, { type: 'scanParquetByFeatureCodes' }> = {
    type: 'scanParquetByFeatureCodes',
    ...input,
  };
  const result = await postRequest<Extract<PointsWorkerResponse, { ok: true }>['result']>(
    request,
    transferablesForRequest(request)
  );
  if (result.kind !== 'columnarScan') {
    throw new Error('Unexpected points worker response for scanParquetByFeatureCodes');
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
  ensurePointsWorker();
  if (!isPointsWorkerEnabled() || input.rowGroups.length === 0) {
    return null;
  }
  const request: Extract<PointsWorkerRequest, { type: 'scanMortonRowGroupsInBounds' }> = {
    type: 'scanMortonRowGroupsInBounds',
    ...input,
  };
  const result = await postRequest<Extract<PointsWorkerResponse, { ok: true }>['result']>(
    request,
    transferablesForRequest(request)
  );
  if (result.kind !== 'columnar') {
    throw new Error('Unexpected points worker response for scanMortonRowGroupsInBounds');
  }
  return columnarDataFromWorkerResult(result);
}

export async function decodeParquetPartsInWorker(
  parts: Uint8Array[],
  columns?: string[],
  maxRows?: number
): Promise<ReturnType<typeof tableFromIPC>> {
  ensurePointsWorker();
  if (!isPointsWorkerEnabled()) {
    throw new Error('Points worker is required for decodeParquetPartsInWorker');
  }
  const result = await postRequest<Extract<PointsWorkerResponse, { ok: true }>['result']>({
    type: 'decodeParquetParts',
    parts,
    columns,
    maxRows,
  });
  if (result.kind !== 'parquetTable') {
    throw new Error('Unexpected points worker response for decodeParquetParts');
  }
  return tableFromIPC(result.tableIpc);
}

export async function buildFeatureCatalogInWorker(
  featureKey: string,
  tableIpc: Uint8Array
): Promise<PointsFeatureCatalog> {
  ensurePointsWorker();
  if (!isPointsWorkerEnabled()) {
    throw new Error('Points worker is required for buildFeatureCatalogInWorker');
  }
  const result = await postRequest<Extract<PointsWorkerResponse, { ok: true }>['result']>({
    type: 'buildFeatureCatalog',
    featureKey,
    tableIpc,
  });
  if (result.kind !== 'catalog') {
    throw new Error('Unexpected points worker response for buildFeatureCatalog');
  }
  return result.catalog;
}
