import * as zarr from 'zarrita';
import type { ZarrTree, ConsolidatedStore, ZAttrsAny, IntermediateConsolidatedStore } from './types';
import { ATTRS_KEY, ZARRAY_KEY } from './types';
import { Err, Ok, type Result } from './result';

/**
 * As of this writing, this returns a nested object, leaf nodes have async functions that return the zarr array.
 * 
 * This traverses arbitrary group depth etc - handy for a generic zarr thing, but for SpatialData we can have
 * something more explicitly targetting the expected structure.
 */
export async function parseStoreContents(store: IntermediateConsolidatedStore): Promise<ZarrTree> {
  // this can await get metadata without too much issue given we know it's already there...
  const root = await zarr.open(store, { kind: 'group' });
  const contents = store.contents().map(v => {
    const pathParts = v.path.split('/');
    // might do something with the top-level element name - ie, make a different kind of object for each
      
    const path = pathParts.slice(1);
    return { path, kind: v.kind, v };
  }).sort((a, b) => a.path.length - b.path.length).slice(1); // skip the root group itself


  const tree: ZarrTree = {};
  for (const item of contents) {
    let currentNode = tree;
    for (const [i, part] of item.path.entries()) {
      if (!(part in currentNode)) {
        const leaf = (i === (item.path.length - 1)) && item.kind === "array";
        // get zattrs... says it's `async` but I strongly don't want it to actually be fetching unncessarily.
        // current implementation will use the existing zmetadata and will need to be adapted to zarr.json in v3
        const attrs = await getZattrs(item.v.path, store);
        if (leaf) {
          const zarray = await getZattrs(item.v.path, store, ".zarray");
          // I suppose this could cache itself as well, but I'm not sure this is really for actual use
          currentNode[part] = {
            [ATTRS_KEY]: attrs,
            [ZARRAY_KEY]: zarray ?? ({} as ZAttrsAny),
            get: () => zarr.open(root.resolve(item.v.path), { kind: 'array' })
          };
        } else {
          currentNode[part] = { [ATTRS_KEY]: attrs };
        }
      }
      // `as ZarrTree` isn't correct, but believed ok for now internally
      currentNode = currentNode[part] as ZarrTree;
    }
  }
  return tree;
}

// we might not always use the FetchStore, this is for convenience & could change
/**
 * There is a tendency for .zmetadata to be misnamed as zmetadata...
 */
export async function tryConsolidated(store: zarr.FetchStore): Promise<IntermediateConsolidatedStore> {
  // in future, first we'll try zarr.json
  // and I'm sure we can make this implementation less ugly, kinda trivial though so cba for now.
  //!!! nb - we need to also handle local files, in which case we don't fetch(url), we need another method - this is important
  try {
    const path = `${store.url}/.zmetadata`;
    // is there a zod schema we could be using here?
    const zmetadata = await (await fetch(path)).json();
    const zarrita = await zarr.withConsolidated(store);
    return { ...zarrita, zmetadata }
  } catch {
    try {
      const path = `${store.url}/zmetadata`;
      const zmetadata = await (await fetch(path)).json();
      const zarrita = await zarr.withConsolidated(store, { metadataKey: 'zmetadata' });
      return { ...zarrita, zmetadata }
    } catch {
      throw new Error(`Couldn't open consolidated metadata for '${store.url}' - n.b. zarr v3 / spatialdata >0.5 is not supported yet`);
    }
  }
  
  // nb for now we explicitly only support consolidated store, so if it doesn't find either key this is an error
  // --- also note, as of writing zarrita doesn't support consolidated metadata on v3 stores 
  // - meaning in that case we might not use its `withConsolidated` function at all (especially since it's IMO not as useful as it should be even for v2), 
  // so we should refactor our parsing to not use `ListableStore.contents()` and probably avoid the extra fetch.
  // return zarr.withConsolidated(store).catch(() => zarr.withConsolidated(store, { metadataKey: 'zmetadata' }));
}

/**
 * Try to open a consolidated `zarr` store and return a `Result<ConsolidatedStore>`,
 */
export async function openExtraConsolidated(source: string): Promise<Result<ConsolidatedStore>> {
  // could `source` also be a File or something?
  try {
    const store = new zarr.FetchStore(source);
    const zarritaStore = await tryConsolidated(store);
    if (!('contents' in zarritaStore)) {
      return Err(new Error(`No consolidated metadata in store '${source}'`));
    }
    const tree = await parseStoreContents(zarritaStore);
    return Ok({ zarritaStore, tree });
  } catch (error) {
    return Err(new Error(`${error}`));
  }
}


/**
 * Get zarr attributes from a consolidated store's metadata
 */
export async function getZattrs(path: zarr.AbsolutePath, store: IntermediateConsolidatedStore, k=".zattrs"): Promise<Record<string, unknown> | undefined> {
  const attrPath = `${path}/${k}`.slice(1);
  const attr = store.zmetadata.metadata[attrPath]; //may be undefined, that's fine.
  if (!attr) return undefined;
  return attr;
}

/**
 * Deep clone a ZarrTree, converting Symbol-keyed attrs to string keys for serialization/debugging
 */
export function serializeZarrTree(obj: ZarrTree | unknown): unknown {
  if (obj === null || typeof obj !== 'object') return obj;

  const result: Record<string, unknown> = {};

  // Copy Symbol properties to string keys
  if (ATTRS_KEY in obj && obj[ATTRS_KEY]) {
    result._attrs = obj[ATTRS_KEY];
  }
  if (ZARRAY_KEY in obj && obj[ZARRAY_KEY]) {
    result._zarray = obj[ZARRAY_KEY];
  }

  // Copy regular properties
  for (const key in obj) {
    if (Object.prototype.hasOwnProperty.call(obj, key)) {
      //@ts-expect-error
      const val = obj[key];
      // Don't serialize functions (like 'get')
      if (typeof val === 'function') {
        result[key] = '<function>';
      } else {
        result[key] = serializeZarrTree(val);
      }
    }
  }

  return result;
}

// Re-export types
export type { ZarrTree, ConsolidatedStore, LazyZarrArray, ZAttrsAny } from './types';
export { ATTRS_KEY, ZARRAY_KEY } from './types';

// Re-export Result type and utilities
export type { Result } from './result';
export { Ok, Err, isOk, isErr, unwrap, unwrapOr } from './result';

