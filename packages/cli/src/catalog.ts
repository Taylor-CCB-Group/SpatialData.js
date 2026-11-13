import { readdir, realpath, stat } from 'node:fs/promises';
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
}

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

export function buildCatalog(name: string, stores: string[]): Catalog {
  return {
    version: 1,
    name,
    stores: stores.map((path) => ({
      path,
      url: DATA_PREFIX + path.split('/').map(encodeURIComponent).join('/'),
    })),
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
