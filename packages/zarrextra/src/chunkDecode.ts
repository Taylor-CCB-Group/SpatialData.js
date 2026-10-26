import type { ChunkCache, GetWorkerOptions } from '@fideus-labs/fizarrita';
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
  /**
   * Decoded chunks for this read: looked up before a chunk is fetched, filled after
   * it is decoded. Takes the place of the backend's cache, so a caller can keep its
   * chunks under a budget of its own. Concurrent reads through one cache share each
   * chunk's fetch and decode, on either backend.
   *
   * Cached chunks are shared, not copied: a read copies out of them and never
   * writes to them.
   */
  cache?: ChunkCache;
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
 * `Chunk<D>` otherwise — and this seam only ever passes a selection whose *type*
 * admits `null`, so the conditional resolves on the `Chunk<D>` branch anyway.
 * Restating it here spares the call site an assertion.
 *
 * That resolution is static, though. A selection that happens to hold only
 * numbers still indexes a point and still comes back as a scalar, which is what
 * {@link assertChunk} is there to catch.
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

/**
 * Guard that a read really produced a chunk rather than a scalar.
 *
 * Both backends are typed here as returning `Chunk<D>`, and both can be wrong at
 * runtime for the same reason. `selection` is declared as
 * `Array<number | zarr.Slice | null>`, so zarrita's conditional return type
 * resolves on its `null` branch and settles on `Chunk<D>` — but the branch taken
 * at runtime depends on the *values*, and an all-number selection like
 * `[0, 0, 0]` indexes a single point, which comes back as a bare `Scalar<D>`.
 * That is the one place the static type lies, and it lies identically on both
 * paths. The fizarrita path has a second reason on top: it is an injection seam,
 * so its type says what a correct impl returns, not what one did.
 *
 * Cheap either way, and it trades a downstream shape crash for a named error.
 */
function assertChunk(result: unknown, source: string): void {
  if (typeof result !== 'object' || result === null || !('data' in result)) {
    throw new Error(`Expected chunk object from ${source}.`);
  }
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
      cache: opts?.cache ?? backend.options?.cache,
      signal: opts?.signal,
    });
    assertChunk(result, 'fizarrita getWorker()');
    return result;
  }

  // zarrita takes `signal` as a first-class option: it forwards it to every
  // `store.get` and re-checks it between chunks, so a multi-chunk read stops
  // early rather than running the rest out.
  const source = opts?.cache ? withChunkCache(arr, opts.cache) : arr;
  const result = await zarr.get(source, selection, { signal: opts?.signal });
  assertChunk(result, 'zarr.get()');
  return result;
}

// --- main-thread chunk cache -------------------------------------------------

/** One chunk being fetched and decoded, shared by every read that wants it meanwhile. */
interface Flight {
  promise: Promise<zarr.Chunk<zarr.DataType>>;
  controller: AbortController;
  waiters: number;
}

/**
 * Chunks in flight, per cache. Bookkeeping attached to the caller's cache rather
 * than a cache of its own: it holds only reads still running.
 */
const flightsByCache = new WeakMap<ChunkCache, Map<string, Flight>>();

const storeIds = new WeakMap<object, number>();
let nextStoreId = 0;

/** The store's identity in cache keys, so two stores' chunks never collide. */
function storeId(store: object): number {
  let id = storeIds.get(store);
  if (id === undefined) {
    id = nextStoreId++;
    storeIds.set(store, id);
  }
  return id;
}

/**
 * `arr`, with its chunks read through `cache`. `zarr.get` reads every chunk through
 * `arr.getChunk`, so that is the one member replaced; everything else is the array's
 * own, read with the array as receiver so its private fields resolve.
 */
function withChunkCache<D extends zarr.DataType>(
  arr: zarr.Array<D>,
  cache: ChunkCache
): zarr.Array<D> {
  const prefix = `main_${storeId(arr.store)}:${arr.path}:`;
  const getChunk: zarr.Array<D>['getChunk'] = async (coords, options, chunkOptions) => {
    const chunk = await readCachedChunk(
      cache,
      prefix + coords.join('/'),
      options?.signal ?? undefined,
      (signal) => arr.getChunk(coords, { ...options, signal }, chunkOptions)
    );
    // The key names this array, so what it holds was read from this array; the
    // cache's interface is not generic over the dtype, which is all this asserts.
    return chunk as zarr.Chunk<D>;
  };
  return new Proxy(arr, {
    get: (target, prop) => (prop === 'getChunk' ? getChunk : Reflect.get(target, prop, target)),
  });
}

/**
 * The chunk at `key`, from the cache or from one shared read. A caller whose signal
 * aborts is rejected at once, with the signal's reason; the read itself is aborted only when every caller
 * waiting on it has gone, and a read that settles anyway is still cached.
 */
async function readCachedChunk(
  cache: ChunkCache,
  key: string,
  signal: AbortSignal | undefined,
  load: (signal: AbortSignal) => Promise<zarr.Chunk<zarr.DataType>>
): Promise<zarr.Chunk<zarr.DataType>> {
  signal?.throwIfAborted();
  const cached = cache.get(key);
  if (cached) return cached;
  let flights = flightsByCache.get(cache);
  if (!flights) {
    flights = new Map();
    flightsByCache.set(cache, flights);
  }
  let flight = flights.get(key);
  // A flight whose callers have all gone is aborting: it cannot serve a new one.
  if (!flight || flight.controller.signal.aborted) flight = startFlight(cache, flights, key, load);
  return joinFlight(flight, signal);
}

function startFlight(
  cache: ChunkCache,
  flights: Map<string, Flight>,
  key: string,
  load: (signal: AbortSignal) => Promise<zarr.Chunk<zarr.DataType>>
): Flight {
  const controller = new AbortController();
  const promise = load(controller.signal)
    .then((chunk) => {
      cache.set(key, chunk);
      return chunk;
    })
    .finally(() => {
      if (flights.get(key) === flight) flights.delete(key);
    });
  // Each caller is given the failure; this only stops it surfacing as unhandled
  // when every caller has already gone.
  promise.catch(() => {});
  const flight: Flight = { promise, controller, waiters: 0 };
  flights.set(key, flight);
  return flight;
}

/** Wait on a flight; when its last caller aborts, abort the flight too. */
function joinFlight(flight: Flight, signal: AbortSignal | undefined) {
  flight.waiters++;
  // A caller with no signal never leaves, so the flight runs to the end.
  if (!signal) return flight.promise;
  return new Promise<zarr.Chunk<zarr.DataType>>((resolve, reject) => {
    const leave = () => {
      reject(signal.reason);
      if (--flight.waiters === 0) flight.controller.abort();
    };
    signal.addEventListener('abort', leave, { once: true });
    flight.promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', leave));
  });
}
