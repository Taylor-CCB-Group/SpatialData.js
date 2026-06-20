import { tableFromIPC } from 'apache-arrow';
import type { PointsColumnarData } from '../spatialViewFit.js';
import type { PointsFeatureCatalog } from '../pointsTiling.js';
import {
  columnarDataFromWorkerResult,
  type PointsWorkerMessage,
  type PointsWorkerRequest,
  type PointsWorkerResponse,
} from './pointsWorkerProtocol.js';

let worker: Worker | undefined;
let nextRequestId = 0;
const pending = new Map<
  number,
  { resolve: (value: unknown) => void; reject: (error: Error) => void }
>();

let enabled = false;
let defaultEnabled = typeof window !== 'undefined';

function ensureWorkerListener() {
  if (!worker) {
    return;
  }
  worker.onmessage = (event: MessageEvent<PointsWorkerMessage>) => {
    const message = event.data;
    if (message.direction !== 'response') {
      return;
    }
    const entry = pending.get(message.id);
    if (!entry) {
      return;
    }
    pending.delete(message.id);
    if (message.response.ok) {
      entry.resolve(message.response.result);
    } else {
      entry.reject(new Error(message.response.error));
    }
  };
  worker.onerror = (event) => {
    for (const [, entry] of pending) {
      entry.reject(new Error(event.message || 'Points worker error'));
    }
    pending.clear();
  };
}

function postRequest<T>(request: PointsWorkerRequest): Promise<T> {
  const activeWorker = worker;
  if (!activeWorker) {
    return Promise.reject(new Error('Points worker is not enabled'));
  }
  const id = ++nextRequestId;
  return new Promise<T>((resolve, reject) => {
    pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
    const message: PointsWorkerMessage = { id, direction: 'request', request };
    activeWorker.postMessage(message);
  });
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
  const workerUrl = options.workerUrl ?? new URL('./points-worker.js', import.meta.url);
  worker = new Worker(workerUrl, { type: 'module' });
  ensureWorkerListener();
  enabled = true;
}

export function disablePointsWorker() {
  enabled = false;
  if (worker) {
    worker.terminate();
    worker = undefined;
  }
  for (const [, entry] of pending) {
    entry.reject(new Error('Points worker disabled'));
  }
  pending.clear();
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

  const xs = data.data[0] instanceof Float32Array
    ? data.data[0]
    : Float32Array.from(data.data[0] as ArrayLike<number>);
  const ys = data.data[1] instanceof Float32Array
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

export async function decodeParquetRowFeatureCodesInWorker(
  parts: Uint8Array[],
  columns: string[],
  options: {
    maxRows?: number;
    featureKey: string;
    featureCodeColumnName?: string;
  }
): Promise<Int32Array> {
  ensurePointsWorker();
  if (!isPointsWorkerEnabled()) {
    throw new Error('Points worker is required for decodeParquetRowFeatureCodesInWorker');
  }
  const result = await postRequest<Extract<PointsWorkerResponse, { ok: true }>['result']>({
    type: 'decodeParquetRowFeatureCodes',
    parts,
    columns,
    maxRows: options.maxRows,
    featureKey: options.featureKey,
    featureCodeColumnName: options.featureCodeColumnName,
  });
  if (result.kind !== 'rowFeatureCodes') {
    throw new Error('Unexpected points worker response for decodeParquetRowFeatureCodes');
  }
  return result.codes;
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

export async function scanParquetFeatureCountsInWorker(
  parts: Uint8Array[],
  featureKey: string,
  featureCodeColumnName?: string
): Promise<Map<number, number>> {
  ensurePointsWorker();
  if (!isPointsWorkerEnabled()) {
    throw new Error('Points worker is required for scanParquetFeatureCountsInWorker');
  }
  const result = await postRequest<Extract<PointsWorkerResponse, { ok: true }>['result']>({
    type: 'scanParquetFeatureCounts',
    parts,
    featureKey,
    featureCodeColumnName,
  });
  if (result.kind !== 'featureCounts') {
    throw new Error('Unexpected points worker response for scanParquetFeatureCounts');
  }
  const counts = new Map<number, number>();
  for (let index = 0; index < result.codes.length; index += 1) {
    counts.set(result.codes[index], result.counts[index]);
  }
  return counts;
}

export async function scanParquetByFeatureCodesInWorker(
  parts: Uint8Array[],
  options: {
    axisNames: string[];
    featureKey: string;
    featureCodeColumnName?: string;
    featureCodes: readonly number[];
    memoryCap: number;
  }
): Promise<{
  data: PointsColumnarData;
  matchedRows: number;
  scannedRows: number;
}> {
  ensurePointsWorker();
  if (!isPointsWorkerEnabled()) {
    throw new Error('Points worker is required for scanParquetByFeatureCodesInWorker');
  }
  const result = await postRequest<Extract<PointsWorkerResponse, { ok: true }>['result']>({
    type: 'scanParquetByFeatureCodes',
    parts,
    axisNames: options.axisNames,
    featureKey: options.featureKey,
    featureCodeColumnName: options.featureCodeColumnName,
    featureCodes: options.featureCodes,
    memoryCap: options.memoryCap,
  });
  if (result.kind !== 'columnarScan') {
    throw new Error('Unexpected points worker response for scanParquetByFeatureCodes');
  }
  return {
    data: columnarDataFromWorkerResult(result),
    matchedRows: result.matchedRows,
    scannedRows: result.scannedRows,
  };
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
