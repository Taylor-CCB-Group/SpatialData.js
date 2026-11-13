import { readdir, readFile, realpath, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';

/**
 * The catalog a viewer reads with `?catalog=<url>`. Store `url`s are relative to the
 * catalog's own URL, so a statically hosted `catalog.json` works the same way.
 * The Python server (python/sdjs) writes the same shape.
 */
export interface Catalog {
  version: 1;
  name: string;
  stores: CatalogEntry[];
}

export interface CatalogEntry {
  /** Path under the served root, `/`-separated. */
  path: string;
  /** Relative to the catalog URL. */
  url: string;
  /** Absent when not inspected (zip archives). */
  kind?: StoreKind;
}

/**
 * `zarr` is a zarr group without SpatialData's root attributes; `unknown` has no zarr
 * root metadata at all.
 */
export type StoreKind = 'spatialdata' | 'zarr' | 'unknown';

/** Where store files are served, relative to the token prefix. */
export const DATA_PREFIX = 'data/';

const SKIPPED_DIRS = new Set(['node_modules', '__pycache__']);

export function isStoreName(name: string, isDirectory: boolean): boolean {
  const lower = name.toLowerCase();
  return isDirectory ? lower.endsWith('.zarr') : lower.endsWith('.zarr.zip');
}

function isSkipped(name: string): boolean {
  return name.startsWith('.') || SKIPPED_DIRS.has(name);
}

/** A store given directly as the root is served from its parent, alone. */
export interface ServedRoot {
  dir: string;
  /** Set when only this one store (a name in `dir`) may be served. */
  only?: string;
}

export async function resolveServedRoot(path: string): Promise<ServedRoot> {
  const info = await stat(path);
  const name = basename(path);
  if (isStoreName(name, info.isDirectory())) {
    return { dir: join(path, '..'), only: name };
  }
  if (!info.isDirectory()) {
    throw new Error(`${path} is neither a directory nor a .zarr / .zarr.zip store`);
  }
  return { dir: path };
}

/**
 * Stores under `root.dir`, stopping at each store. Hidden and dependency directories
 * are skipped; symlinks are followed once.
 */
export async function findStores(root: ServedRoot, maxDepth = 8): Promise<string[]> {
  if (root.only) return [root.only];
  const found: string[] = [];
  const seen = new Set<string>();

  async function walk(dir: string, rel: string[], depth: number): Promise<void> {
    const real = await realpath(dir).catch(() => null);
    if (real === null || seen.has(real)) return;
    seen.add(real);
    const entries = await readdir(dir).catch(() => []);
    for (const name of entries.sort()) {
      if (isSkipped(name)) continue;
      const info = await stat(join(dir, name)).catch(() => null);
      if (!info) continue;
      if (isStoreName(name, info.isDirectory())) {
        found.push([...rel, name].join('/'));
      } else if (info.isDirectory() && depth < maxDepth) {
        await walk(join(dir, name), [...rel, name], depth + 1);
      }
    }
  }

  await walk(root.dir, [], 0);
  return found;
}

async function readRootAttributes(dir: string): Promise<Record<string, unknown> | null> {
  const readJson = (name: string) =>
    readFile(join(dir, name), 'utf8').then(
      (text): unknown => JSON.parse(text),
      () => undefined
    );
  const isRecord = (v: unknown): v is Record<string, unknown> =>
    typeof v === 'object' && v !== null && !Array.isArray(v);
  const v3 = await readJson('zarr.json');
  if (isRecord(v3)) return isRecord(v3.attributes) ? v3.attributes : {};
  if ((await readJson('.zgroup')) === undefined) return null;
  const v2 = await readJson('.zattrs');
  return isRecord(v2) ? v2 : {};
}

/**
 * Reads one root metadata file. Zips are not inspected: finding a member means reading
 * the whole central directory, which for a large archive is most of a catalog request.
 */
export async function classifyStore(path: string): Promise<StoreKind | undefined> {
  if (isStoreName(basename(path), false)) return undefined;
  const attrs = await readRootAttributes(path);
  if (attrs === null) return 'unknown';
  return 'spatialdata_attrs' in attrs ? 'spatialdata' : 'zarr';
}

export async function buildCatalog(root: ServedRoot, stores: string[]): Promise<Catalog> {
  return {
    version: 1,
    name: basename(root.only ?? root.dir),
    stores: await Promise.all(
      stores.map(async (path) => {
        const kind = await classifyStore(join(root.dir, ...path.split('/')));
        return {
          path,
          url: DATA_PREFIX + path.split('/').map(encodeURIComponent).join('/'),
          ...(kind && { kind }),
        };
      })
    ),
  };
}

/**
 * Whether a request path (decoded segments under the data prefix) lies inside a store.
 * Name-based, so stores added after start are served; hidden segments are refused
 * only above the store, since `.zattrs` and friends live inside it.
 */
export function isServablePath(segments: string[], only?: string): boolean {
  const unsafe = (s: string) => s === '' || s === '.' || s === '..' || /[\\/\0]/.test(s);
  if (segments.some(unsafe)) return false;
  const last = segments.length - 1;
  const store = segments.findIndex(
    (s, i) => isStoreName(s, true) || (i === last && isStoreName(s, false))
  );
  if (store < 0 || segments.slice(0, store).some(isSkipped)) return false;
  return only === undefined || (store === 0 && segments[0] === only);
}
