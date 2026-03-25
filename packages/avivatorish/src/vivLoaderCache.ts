/**
 * Loader and tile caches for Viv (ported from MDV viv_loader_cache.ts, no MobX).
 */

import { loadOmeZarr } from '@hms-dbmi/viv';
import { createLoader, type UrlOrFiles } from './utils';

const LOG_PREFIX = '[vivLoaderCache]';
const SLOW_TILE_LOAD_LOG_MS = 750;
const DEFAULT_MAX_CACHE_ENTRIES = 12;
const DEFAULT_MAX_TILE_CACHE_ENTRIES = 800;

type LoaderCallbacks = {
  handleOffsetsNotFound: (value: boolean) => void;
  handleLoaderError: (message: string | null) => void;
};

type CacheEntry = {
  lastAccessMs: number;
  value?: unknown;
  promise?: Promise<unknown>;
  subscribers: Set<LoaderCallbacks>;
};

const vivLoaderCache = new Map<string, CacheEntry>();

type TileCacheEntry = {
  lastAccessMs: number;
  value?: unknown;
  promise?: Promise<unknown>;
};
const vivTileCache = new Map<string, TileCacheEntry>();

const telemetry = {
  loaderCacheHitValue: 0,
  loaderCacheHitInflight: 0,
  loaderCacheMissNew: 0,
  loaderPassthroughNonStringUrl: 0,
  loaderCreateFailures: 0,
  loaderEntriesPruned: 0,
  tileCacheHit: 0,
  tileCacheInflightReuse: 0,
  tileCacheMissLoad: 0,
  tileLoadFailures: 0,
  tileEntriesPruned: 0,
  pixelSourcesWrapped: 0,
  loaderCreateDurationMsTotal: 0,
  loaderCreateCompletedCount: 0,
};

let telemetrySubscribers: Array<() => void> = [];
let telemetryPublishTimer: ReturnType<typeof setTimeout> | undefined;

function publishTelemetry() {
  if (telemetryPublishTimer !== undefined) return;
  telemetryPublishTimer = setTimeout(() => {
    telemetryPublishTimer = undefined;
    for (const cb of telemetrySubscribers) {
      try {
        cb();
      } catch {
        /* ignore */
      }
    }
  }, 250);
}

export function subscribeVivLoaderCacheTelemetry(cb: () => void): () => void {
  telemetrySubscribers.push(cb);
  return () => {
    telemetrySubscribers = telemetrySubscribers.filter((x) => x !== cb);
  };
}

export type VivLoaderCacheTelemetry = Readonly<typeof telemetry> & {
  vivLoaderCacheSize: number;
  vivTileCacheSize: number;
  avgLoaderCreateMs: number;
};

export function getVivLoaderCacheTelemetry(): VivLoaderCacheTelemetry {
  const avgLoaderCreateMs =
    telemetry.loaderCreateCompletedCount > 0
      ? telemetry.loaderCreateDurationMsTotal / telemetry.loaderCreateCompletedCount
      : 0;
  return {
    ...telemetry,
    vivLoaderCacheSize: vivLoaderCache.size,
    vivTileCacheSize: vivTileCache.size,
    avgLoaderCreateMs,
  };
}

function truncateForLog(s: string, max = 160) {
  if (s.length <= max) return s;
  return `${s.slice(0, max)}…(${s.length} chars)`;
}

function touchEntry(entry: CacheEntry) {
  entry.lastAccessMs = Date.now();
}

function notifyOffsets(entry: CacheEntry, value: boolean) {
  for (const subscriber of entry.subscribers) {
    subscriber.handleOffsetsNotFound(value);
  }
}

function notifyLoaderError(entry: CacheEntry, message: string | null) {
  for (const subscriber of entry.subscribers) {
    subscriber.handleLoaderError(message);
  }
}

function getCacheKey(urlOrFile: UrlOrFiles) {
  return typeof urlOrFile === 'string' ? urlOrFile : null;
}

export function pruneVivLoaderCache(maxEntries = DEFAULT_MAX_CACHE_ENTRIES) {
  if (vivLoaderCache.size <= maxEntries) return;
  const removable = [...vivLoaderCache.entries()]
    .filter(([, entry]) => !entry.promise)
    .sort((a, b) => a[1].lastAccessMs - b[1].lastAccessMs);
  let toRemove = vivLoaderCache.size - maxEntries;
  let removed = 0;
  for (const [key] of removable) {
    if (toRemove <= 0) break;
    const current = vivLoaderCache.get(key);
    if (!current || current.promise) continue;
    vivLoaderCache.delete(key);
    toRemove -= 1;
    removed += 1;
  }
  if (removed > 0) {
    telemetry.loaderEntriesPruned += removed;
    console.debug(
      `${LOG_PREFIX} pruned ${removed} loader entries (max=${maxEntries}, remaining=${vivLoaderCache.size})`,
    );
    publishTelemetry();
  }
}

function stableSerialize(value: unknown): string {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  const t = typeof value;
  if (t === 'number' || t === 'boolean' || t === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((v) => stableSerialize(v)).join(',')}]`;
  if (t === 'object') {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${stableSerialize(obj[k])}`).join(',')}}`;
  }
  return JSON.stringify(String(value));
}

function pruneVivTileCache(maxEntries = DEFAULT_MAX_TILE_CACHE_ENTRIES) {
  if (vivTileCache.size <= maxEntries) return;
  const removable = [...vivTileCache.entries()]
    .filter(([, entry]) => !entry.promise)
    .sort((a, b) => a[1].lastAccessMs - b[1].lastAccessMs);
  let toRemove = vivTileCache.size - maxEntries;
  let removed = 0;
  for (const [key] of removable) {
    if (toRemove <= 0) break;
    const current = vivTileCache.get(key);
    if (!current || current.promise) continue;
    vivTileCache.delete(key);
    toRemove -= 1;
    removed += 1;
  }
  if (removed > 0) {
    telemetry.tileEntriesPruned += removed;
    console.debug(
      `${LOG_PREFIX} pruned ${removed} tile entries (max=${maxEntries}, remaining=${vivTileCache.size})`,
    );
    publishTelemetry();
  }
}

async function getOrCreateTileData(
  key: string,
  signal: AbortSignal | undefined,
  load: () => Promise<unknown>,
) {
  const existing = vivTileCache.get(key);
  if (existing?.value) {
    telemetry.tileCacheHit += 1;
    publishTelemetry();
    existing.lastAccessMs = Date.now();
    return existing.value;
  }
  if (!signal && existing?.promise) {
    telemetry.tileCacheInflightReuse += 1;
    publishTelemetry();
    existing.lastAccessMs = Date.now();
    return existing.promise;
  }

  const entry: TileCacheEntry = existing ?? { lastAccessMs: Date.now() };
  entry.lastAccessMs = Date.now();
  telemetry.tileCacheMissLoad += 1;
  publishTelemetry();
  const t0 = performance.now();
  const promise = load()
    .then((value) => {
      const dt = performance.now() - t0;
      if (dt >= SLOW_TILE_LOAD_LOG_MS) {
        console.warn(`${LOG_PREFIX} slow tile load ${dt.toFixed(0)}ms`, truncateForLog(key));
      }
      entry.value = value;
      entry.promise = undefined;
      entry.lastAccessMs = Date.now();
      vivTileCache.set(key, entry);
      pruneVivTileCache();
      publishTelemetry();
      return value;
    })
    .catch((error) => {
      telemetry.tileLoadFailures += 1;
      publishTelemetry();
      console.warn(`${LOG_PREFIX} tile load failed`, truncateForLog(key), error);
      const current = vivTileCache.get(key);
      if (current?.promise === promise) {
        vivTileCache.delete(key);
      }
      throw error;
    });

  if (!signal) {
    entry.promise = promise;
    vivTileCache.set(key, entry);
    pruneVivTileCache();
  }

  return promise;
}

type TileArgs = { x: number; y: number; selection: unknown; signal?: AbortSignal };
type RasterArgs = { selection: unknown; signal?: AbortSignal };
type PixelSourceLike = {
  getTile?: (args: TileArgs) => Promise<unknown>;
  getRaster?: (args: RasterArgs) => Promise<unknown>;
  pool?: unknown;
};

const pixelSourceWrapperCache = new WeakMap<object, PixelSourceLike>();

function isLikelyZarrPixelSource(source: PixelSourceLike) {
  return (
    typeof source.getTile === 'function' &&
    typeof source.getRaster === 'function' &&
    !('pool' in source)
  );
}

function wrapPixelSource(source: PixelSourceLike, sourceKey: string, levelKey: string) {
  if (!isLikelyZarrPixelSource(source)) return source;
  const existing = pixelSourceWrapperCache.get(source as object);
  if (existing) return existing;

  const wrapped = new Proxy(source as object, {
    get(target, prop, receiver) {
      if (prop === 'getTile') {
        return async (args: TileArgs) => {
          const key = `${sourceKey}|${levelKey}|tile|x:${args.x}|y:${args.y}|sel:${stableSerialize(args.selection)}`;
          return getOrCreateTileData(key, args.signal, () =>
            (source.getTile as NonNullable<PixelSourceLike['getTile']>)(args),
          );
        };
      }
      if (prop === 'getRaster') {
        return async (args: RasterArgs) => {
          const key = `${sourceKey}|${levelKey}|raster|sel:${stableSerialize(args.selection)}`;
          return getOrCreateTileData(key, args.signal, () =>
            (source.getRaster as NonNullable<PixelSourceLike['getRaster']>)(args),
          );
        };
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value;
    },
  });
  pixelSourceWrapperCache.set(source as object, wrapped);
  telemetry.pixelSourcesWrapped += 1;
  publishTelemetry();
  console.debug(`${LOG_PREFIX} wrapped Zarr-like PixelSource for tile cache`, truncateForLog(sourceKey));
  return wrapped;
}

function wrapLoaderResultForTileCache(result: unknown, sourceKey: string): unknown {
  if (Array.isArray(result)) {
    return result.map((image, imageIndex) => ({
      ...image,
      data: image.data.map((source: PixelSourceLike, levelIndex: number) =>
        wrapPixelSource(source, sourceKey, `img:${imageIndex}|lvl:${levelIndex}`),
      ),
    }));
  }
  if (result && typeof result === 'object' && 'data' in result && Array.isArray((result as { data: unknown[] }).data)) {
    const r = result as { data: PixelSourceLike[] };
    return {
      ...r,
      data: r.data.map((source, levelIndex) =>
        wrapPixelSource(source, sourceKey, `img:0|lvl:${levelIndex}`),
      ),
    };
  }
  return result;
}

export async function getOrCreateVivLoader(
  urlOrFile: UrlOrFiles,
  handleOffsetsNotFound: (value: boolean) => void,
  handleLoaderError: (message: string | null) => void,
): Promise<unknown> {
  const cacheKey = getCacheKey(urlOrFile);
  if (!cacheKey) {
    telemetry.loaderPassthroughNonStringUrl += 1;
    publishTelemetry();
    console.debug(`${LOG_PREFIX} uncached createLoader (non-string UrlOrFiles)`);
    return createLoader(urlOrFile, handleOffsetsNotFound, handleLoaderError);
  }

  const subscriber: LoaderCallbacks = { handleOffsetsNotFound, handleLoaderError };
  const existing = vivLoaderCache.get(cacheKey);
  if (existing) {
    touchEntry(existing);
    if (existing.value) {
      telemetry.loaderCacheHitValue += 1;
      publishTelemetry();
      console.debug(`${LOG_PREFIX} loader cache hit (ready)`, truncateForLog(cacheKey));
      return existing.value;
    }
    if (existing.promise) {
      telemetry.loaderCacheHitInflight += 1;
      publishTelemetry();
      console.debug(`${LOG_PREFIX} loader cache hit (in-flight)`, truncateForLog(cacheKey));
      existing.subscribers.add(subscriber);
      try {
        return await existing.promise;
      } finally {
        existing.subscribers.delete(subscriber);
      }
    }
  }

  telemetry.loaderCacheMissNew += 1;
  publishTelemetry();
  console.debug(`${LOG_PREFIX} loader cache miss, creating`, truncateForLog(cacheKey));

  const entry: CacheEntry = {
    lastAccessMs: Date.now(),
    subscribers: new Set([subscriber]),
  };
  const loadStartedAt = performance.now();
  const promise = createLoader(
    urlOrFile,
    (value) => notifyOffsets(entry, value),
    (message) => notifyLoaderError(entry, message),
  )
    .then((result) => {
      const dt = performance.now() - loadStartedAt;
      telemetry.loaderCreateDurationMsTotal += dt;
      telemetry.loaderCreateCompletedCount += 1;
      publishTelemetry();
      console.debug(`${LOG_PREFIX} createLoader finished in ${dt.toFixed(0)}ms`, truncateForLog(cacheKey));
      const wrapped = wrapLoaderResultForTileCache(result, cacheKey);
      entry.value = wrapped;
      entry.promise = undefined;
      entry.subscribers.clear();
      touchEntry(entry);
      pruneVivLoaderCache();
      return wrapped;
    })
    .catch((error) => {
      telemetry.loaderCreateFailures += 1;
      publishTelemetry();
      console.warn(`${LOG_PREFIX} createLoader failed`, truncateForLog(cacheKey), error);
      vivLoaderCache.delete(cacheKey);
      entry.subscribers.clear();
      throw error;
    });

  entry.promise = promise;
  vivLoaderCache.set(cacheKey, entry);
  pruneVivLoaderCache();

  try {
    return await promise;
  } finally {
    entry.subscribers.delete(subscriber);
  }
}

type OmeZarrCacheEntry = {
  lastAccessMs: number;
  value?: unknown;
  promise?: Promise<unknown>;
};

const omeZarrLoaderCache = new Map<string, OmeZarrCacheEntry>();

/**
 * Cached `loadOmeZarr(..., { type: 'multiscales' }).data` for SpatialCanvas string URLs.
 */
export async function getOrCreateOmeZarrMultiscalesLoader(url: string): Promise<unknown> {
  const cacheKey = `omezarr|${url}`;
  const existing = omeZarrLoaderCache.get(cacheKey);
  if (existing?.value) {
    existing.lastAccessMs = Date.now();
    return existing.value;
  }
  if (existing?.promise) {
    existing.lastAccessMs = Date.now();
    return existing.promise;
  }

  const entry: OmeZarrCacheEntry = { lastAccessMs: Date.now() };
  const promise = loadOmeZarr(url, { type: 'multiscales' })
    .then((loader) => {
      const data = loader.data;
      const wrapped = Array.isArray(data)
        ? data.map((source, levelIndex: number) =>
            wrapPixelSource(source as PixelSourceLike, cacheKey, `img:0|lvl:${levelIndex}`),
          )
        : data;
      entry.value = wrapped;
      entry.promise = undefined;
      omeZarrLoaderCache.set(cacheKey, entry);
      return wrapped;
    })
    .catch((e) => {
      omeZarrLoaderCache.delete(cacheKey);
      throw e;
    });

  entry.promise = promise;
  omeZarrLoaderCache.set(cacheKey, entry);
  return promise;
}

/** Test-only: clear loader caches (WeakMap wrappers are not cleared). */
export function __resetVivLoaderCachesForTests() {
  vivLoaderCache.clear();
  vivTileCache.clear();
  omeZarrLoaderCache.clear();
}
