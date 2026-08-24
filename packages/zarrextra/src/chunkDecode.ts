import type { GetWorkerOptions } from '@fideus-labs/fizarrita';
import type { WorkerPool } from '@fideus-labs/worker-pool';
import * as zarr from 'zarrita';

export type ZarrGetOptions = {
  /**
   * Cancels the read.
   *
   * Both backends take this as a first-class option and act on it: fetches are
   * aborted at the store, chunk work still queued on the worker pool is dropped
   * rather than started, and the returned promise rejects with the signal's
   * reason. A decode already running on a worker is not interrupted — its result
   * is discarded — so this bounds what a cancelled read *starts*, not what it has
   * already handed to a worker.
   */
  signal?: AbortSignal;
};

export type FizarritaGetWorkerOptions = Pick<
  GetWorkerOptions,
  'workerUrl' | 'useSharedArrayBuffer' | 'cache' | 'signal'
> & {
  pool: WorkerPool;
};

export type ChunkDecodeBackend =
  | { kind: 'main' }
  | {
      kind: 'fizarrita';
      pool: WorkerPool;
      /**
       * Set once when the backend is enabled, so deliberately not `signal`:
       * cancellation belongs to a single read, and a signal parked here would
       * silently govern every read the backend ever serves.
       */
      options?: Omit<FizarritaGetWorkerOptions, 'pool' | 'signal'>;
    };

let chunkDecodeBackend: ChunkDecodeBackend = { kind: 'main' };

export function getChunkDecodeBackend(): ChunkDecodeBackend {
  return chunkDecodeBackend;
}

export function setChunkDecodeBackend(backend: ChunkDecodeBackend): void {
  chunkDecodeBackend = backend;
}

/**
 * The shape of the injected `getWorker`.
 *
 * Generic over `D` so a chunk comes back typed to the array it was read from,
 * rather than as `Chunk<DataType>` needing an assertion at the call site.
 *
 * It is narrower than fizarrita's own signature, deliberately. That one returns
 * a *conditional* type — `Scalar<D>` when every dimension is integer-indexed,
 * `Chunk<D>` otherwise — and this seam only ever passes a selection whose type
 * admits `null`, which lands on the `Chunk<D>` branch. Restating that here keeps
 * the scalar case out of a signature that could not produce it.
 */
type GetWorkerFn = <D extends zarr.DataType>(
  arr: zarr.Array<D>,
  selection: Array<number | zarr.Slice | null> | null,
  options: FizarritaGetWorkerOptions
) => Promise<zarr.Chunk<D>>;

let getWorkerImpl: GetWorkerFn | undefined;

export function setFizarritaGetWorker(impl: GetWorkerFn): void {
  getWorkerImpl = impl;
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
    // The signal goes to fizarrita rather than being watched here. Watching it
    // here only ever stopped us *awaiting* a read: the fetch and the decode ran
    // to completion regardless, so a pan that outran its tiles still paid full
    // price for every one it had already abandoned. Handed over, it aborts the
    // store requests and drops chunk tasks still queued on the pool.
    const result = await getWorkerImpl(arr, selection, {
      pool: backend.pool,
      workerUrl: backend.options?.workerUrl,
      useSharedArrayBuffer: backend.options?.useSharedArrayBuffer,
      cache: backend.options?.cache,
      signal: opts?.signal,
    });
    // Kept even though the type now promises a chunk: this is an injection seam,
    // and the type says what a correct impl returns, not what one did. Deleting
    // it as redundant would trade a named error for a downstream shape crash.
    if (typeof result !== 'object' || result === null || !('data' in result)) {
      throw new Error('Expected chunk object from fizarrita getWorker().');
    }
    return result;
  }

  // zarrita takes `signal` as a first-class option: it forwards it to every
  // `store.get` and re-checks it between chunks, so a multi-chunk read stops
  // early rather than running the rest out. `opts` passes straight through.
  const result = await zarr.get(arr, selection, opts);
  if (typeof result !== 'object' || result === null || !('data' in result)) {
    throw new Error('Expected chunk object from zarr.get().');
  }
  return result as zarr.Chunk<D>;
}
