import * as zarr from 'zarrita';
import type { WorkerPool } from '@fideus-labs/worker-pool';
import type { ChunkCache, GetWorkerOptions } from '@fideus-labs/fizarrita';

export type ZarrGetOptions = {
  signal?: AbortSignal;
};

export type FizarritaGetWorkerOptions = Pick<
  GetWorkerOptions,
  'workerUrl' | 'useSharedArrayBuffer' | 'cache'
> & {
  pool: WorkerPool;
};

export type ChunkDecodeBackend =
  | { kind: 'main' }
  | {
      kind: 'fizarrita';
      pool: WorkerPool;
      options?: Omit<FizarritaGetWorkerOptions, 'pool'>;
    };

let chunkDecodeBackend: ChunkDecodeBackend = { kind: 'main' };

export function getChunkDecodeBackend(): ChunkDecodeBackend {
  return chunkDecodeBackend;
}

export function setChunkDecodeBackend(backend: ChunkDecodeBackend): void {
  chunkDecodeBackend = backend;
}

type GetWorkerFn = (
  arr: zarr.Array<zarr.DataType>,
  selection: Array<number | zarr.Slice | null> | null,
  options: FizarritaGetWorkerOptions
) => Promise<zarr.Chunk<zarr.DataType>>;

let getWorkerImpl: GetWorkerFn | undefined;

export function setFizarritaGetWorker(impl: GetWorkerFn): void {
  getWorkerImpl = impl;
}

function rejectOnAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) {
    return promise;
  }
  if (signal.aborted) {
    return Promise.reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
  }
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      }
    );
  });
}

export async function getZarrChunk<D extends zarr.DataType>(
  arr: zarr.Array<D>,
  selection: Array<number | zarr.Slice | null>,
  opts?: ZarrGetOptions
): Promise<zarr.Chunk<D>> {
  const backend = getChunkDecodeBackend();
  if (backend.kind === 'fizarrita') {
    if (!getWorkerImpl) {
      throw new Error(
        'Worker chunk decode is enabled but fizarrita getWorker is not loaded. ' +
          'Import from zarrextra/workers instead of setting the backend directly.'
      );
    }
    const result = await rejectOnAbort(
      getWorkerImpl(arr, selection, {
        pool: backend.pool,
        workerUrl: backend.options?.workerUrl,
        useSharedArrayBuffer: backend.options?.useSharedArrayBuffer,
        cache: backend.options?.cache,
      }),
      opts?.signal
    );
    if (typeof result !== 'object' || result === null || !('data' in result)) {
      throw new Error('Expected chunk object from fizarrita getWorker().');
    }
    return result as zarr.Chunk<D>;
  }

  const result = await zarr.get(arr, selection, opts);
  if (typeof result !== 'object' || result === null || !('data' in result)) {
    throw new Error('Expected chunk object from zarr.get().');
  }
  return result as zarr.Chunk<D>;
}
