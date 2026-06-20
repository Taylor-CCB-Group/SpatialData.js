import { tableFromIPC } from 'apache-arrow';
import type { PointsColumnarData } from '../spatialViewFit.js';
import type { PointsFeatureCatalog } from '../pointsTiling.js';
import type { PointsWorkerMessage, PointsWorkerRequest, PointsWorkerResponse } from './pointsWorkerProtocol.js';

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

function columnarDataFromWorkerResult(
  result: Extract<PointsWorkerResponse, { ok: true }>['result'] & { kind: 'columnar' }
): PointsColumnarData {
  const data = result.zs ? [result.xs, result.ys, result.zs] : [result.xs, result.ys];
  return { shape: result.shape, data };
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
