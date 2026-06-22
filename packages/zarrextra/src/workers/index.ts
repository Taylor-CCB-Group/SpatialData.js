import { WorkerPool } from '@fideus-labs/worker-pool';
import { getWorker, type ChunkCache, type GetWorkerOptions } from '@fideus-labs/fizarrita';
import { setChunkDecodeBackend, setFizarritaGetWorker } from '../chunkDecode';

export type { ChunkCache } from '@fideus-labs/fizarrita';

export type EnableWorkerChunkDecodeOptions = {
  workers?: number;
  workerUrl?: string | URL;
  useSharedArrayBuffer?: boolean;
  cache?: ChunkCache;
};

let activePool: WorkerPool | undefined;

function defaultWorkerCount() {
  if (typeof navigator !== 'undefined' && navigator.hardwareConcurrency) {
    return Math.min(navigator.hardwareConcurrency, 4);
  }
  return 4;
}

function defaultWorkerUrl() {
  const workerFile = './codec-worker.js';
  return new URL(workerFile, import.meta.url);
}

setFizarritaGetWorker(getWorker);

/** Enable fizarrita worker-pool chunk decode for all subsequent getZarrChunk reads. */
export function enableWorkerChunkDecode(options: EnableWorkerChunkDecodeOptions = {}) {
  if (activePool) {
    disableWorkerChunkDecode();
  }

  const pool = new WorkerPool(options.workers ?? defaultWorkerCount());
  activePool = pool;

  const workerUrl = options.workerUrl ?? defaultWorkerUrl();
  setChunkDecodeBackend({
    kind: 'fizarrita',
    pool,
    options: {
      workerUrl,
      useSharedArrayBuffer: options.useSharedArrayBuffer,
      cache: options.cache,
    },
  });

  return pool;
}

/** Terminate worker pool and restore main-thread zarr.get chunk decode. */
export function disableWorkerChunkDecode() {
  if (activePool) {
    activePool.terminateWorkers();
    activePool = undefined;
  }
  setChunkDecodeBackend({ kind: 'main' });
}

export type { GetWorkerOptions };
