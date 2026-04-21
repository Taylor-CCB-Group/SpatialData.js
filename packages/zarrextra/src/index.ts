import * as zarr from 'zarrita';
import type { ConsolidatedStore, StoreReference, ZarrTree, ZAttrsAny } from './types';
import { ATTRS_KEY, ZARRAY_KEY } from './types';
import { Err, Ok, type Result } from './result';

const decoder = new TextDecoder();

function isReadableStore(source: StoreReference): source is zarr.Readable {
  return typeof source !== 'string';
}

function isListableStore(store: zarr.Readable): store is zarr.Listable<zarr.Readable> {
  return 'contents' in store && typeof store.contents === 'function';
}

function normalizeStringSource(source: string): string {
  return source.replace(/\/+$/, '');
}

function describeSource(source: StoreReference): string {
  return typeof source === 'string' ? source : '[store instance]';
}

function metadataKeysForPath(
  path: zarr.AbsolutePath,
  kind: 'array' | 'group',
): zarr.AbsolutePath[] {
  const basePath = path === '/' ? '' : path;
  if (kind === 'array') {
    return [`${basePath}/zarr.json`, `${basePath}/.zarray`] as zarr.AbsolutePath[];
  }
  return [`${basePath}/zarr.json`, `${basePath}/.zgroup`] as zarr.AbsolutePath[];
}

async function readMetadataJson(
  store: zarr.Readable,
  path: zarr.AbsolutePath,
  kind: 'array' | 'group',
): Promise<ZAttrsAny | undefined> {
  for (const metadataKey of metadataKeysForPath(path, kind)) {
    const bytes = await store.get(metadataKey);
    if (bytes) {
      return JSON.parse(decoder.decode(bytes)) as ZAttrsAny;
    }
  }
  return undefined;
}

async function readNodeAttrs(
  root: zarr.Group<zarr.Readable>,
  path: zarr.AbsolutePath,
  kind: 'array' | 'group',
): Promise<ZAttrsAny> {
  if (path === '/') {
    return root.attrs;
  }

  const node =
    kind === 'array'
      ? await zarr.open(root.resolve(path), { kind: 'array' })
      : await zarr.open(root.resolve(path), { kind: 'group' });
  return node.attrs;
}

function sortContentsByDepth(
  a: { path: zarr.AbsolutePath },
  b: { path: zarr.AbsolutePath },
): number {
  const depthA = a.path.split('/').filter(Boolean).length;
  const depthB = b.path.split('/').filter(Boolean).length;
  return depthA - depthB;
}

async function parseStoreContents(store: zarr.Listable<zarr.Readable>): Promise<ZarrTree> {
  const root = await zarr.open(store, { kind: 'group' });
  const tree: ZarrTree = {
    [ATTRS_KEY]: root.attrs,
  };
  const contents = store.contents().sort(sortContentsByDepth);

  for (const { path, kind } of contents) {
    if (path === '/') continue;

    const pathParts = path.split('/').filter(Boolean);
    let currentNode = tree;

    for (const [index, part] of pathParts.entries()) {
      if (!(part in currentNode)) {
        const isLeaf = index === pathParts.length - 1;

        if (!isLeaf) {
          currentNode[part] = {};
        } else {
          const absolutePath = `/${pathParts.slice(0, index + 1).join('/')}` as zarr.AbsolutePath;
          const attrs = await readNodeAttrs(root, absolutePath, kind);

          if (kind === 'array') {
            const arrayMetadata = await readMetadataJson(store, absolutePath, 'array');
            const leafNode: Partial<Record<keyof ZarrTree, unknown>> & Record<PropertyKey, unknown> = {
              [ATTRS_KEY]: attrs,
              get: () => zarr.open(root.resolve(absolutePath), { kind: 'array' }),
            };
            if (arrayMetadata) {
              leafNode[ZARRAY_KEY] = arrayMetadata;
            }
            currentNode[part] = leafNode as ZarrTree;
          } else {
            currentNode[part] = {
              [ATTRS_KEY]: attrs,
            };
          }
        }
      }

      currentNode = currentNode[part] as ZarrTree;
    }
  }

  return tree;
}

async function resolveListableStore(source: StoreReference): Promise<zarr.Listable<zarr.Readable>> {
  const store = isReadableStore(source)
    ? source
    : new zarr.FetchStore(normalizeStringSource(source));

  if (isListableStore(store)) {
    return store;
  }

  try {
    return await zarr.withConsolidatedMetadata(store as zarr.AsyncReadable);
  } catch (defaultError) {
    try {
      return await zarr.withConsolidatedMetadata(store as zarr.AsyncReadable, {
        format: 'v2',
        metadataKey: 'zmetadata',
      });
    } catch {
      throw defaultError;
    }
  }
}

/**
 * Open a zarr store or store-backed source and return a parsed tree representation.
 */
export async function openExtraConsolidated(
  source: StoreReference,
): Promise<Result<ConsolidatedStore>> {
  try {
    const zarritaStore = await resolveListableStore(source);
    const tree = await parseStoreContents(zarritaStore);
    return Ok({ zarritaStore, tree });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    return Err(new Error(`Failed to open zarr store '${describeSource(source)}': ${errorMessage}`));
  }
}

/**
 * Deep clone a ZarrTree, converting Symbol-keyed attrs to string keys for serialization/debugging
 */
export function serializeZarrTree(obj: ZarrTree | unknown): unknown {
  if (obj === null || typeof obj !== 'object') return obj;

  const result: Record<string, unknown> = {};

  if (ATTRS_KEY in obj && obj[ATTRS_KEY]) {
    result._attrs = obj[ATTRS_KEY];
  }
  if (ZARRAY_KEY in obj && obj[ZARRAY_KEY]) {
    result._zarray = obj[ZARRAY_KEY];
  }

  for (const key in obj) {
    if (Object.prototype.hasOwnProperty.call(obj, key)) {
      // @ts-expect-error - Indexing unknown object for serialization.
      const val = obj[key];
      if (typeof val === 'function') {
        result[key] = '<function>';
      } else {
        result[key] = serializeZarrTree(val);
      }
    }
  }

  return result;
}

export type { StoreReference, ZarrTree, ConsolidatedStore, LazyZarrArray, ZAttrsAny } from './types';
export { ATTRS_KEY, ZARRAY_KEY } from './types';

export type { Result } from './result';
export { Ok, Err, isOk, isErr, unwrap, unwrapOr } from './result';
