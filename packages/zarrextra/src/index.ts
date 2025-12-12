import * as zarr from 'zarrita';
import type { ZarrTree, ConsolidatedStore, ZAttrsAny, IntermediateConsolidatedStore, ZarrV2Metadata, ZarrV3Metadata } from './types';
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

/**
 * Parse zarr v3 consolidated metadata from zarr.json
 * In zarr v3, consolidated metadata may have a different structure than v2.
 * This function normalizes it to a format compatible with our getZattrs function.
 */
async function parseZarrJson(zarrJson: unknown): Promise<Result<ZarrV3Metadata, Error>> {
  if (!zarrJson || typeof zarrJson !== 'object') {
    return Err(new Error(`Invalid zarr.json: expected an object but got ${typeof zarrJson}`));
  }
  
  // zarr v3 zarr.json structure can vary, but typically has metadata nested by path
  const parsed = zarrJson as ZarrV3Metadata;
  
  // If it already has the expected structure, return as-is
  if (parsed.metadata && typeof parsed.metadata === 'object') {
    return Ok(parsed);
  }
  
  // Otherwise, try to normalize the structure
  // This is a fallback for different zarr v3 implementations
  const normalized: ZarrV3Metadata = {
    metadata: parsed.metadata || {},
    ...parsed
  };
  
  if (!normalized.metadata || typeof normalized.metadata !== 'object') {
    return Err(new Error('Invalid zarr.json: metadata field is missing or not an object'));
  }
  
  return Ok(normalized);
}

/**
 * Normalize zarr v2 flat metadata to nested structure like v3
 * Converts flat structure like { "path/.zattrs": {...} } 
 * to nested structure like { "path": { ".zattrs": {...} } }
 */
function normalizeV2ToV3Metadata(v2Metadata: ZarrV2Metadata): ZarrV3Metadata {
  const nested: ZarrV3Metadata['metadata'] = {};
  
  if (!v2Metadata.metadata || typeof v2Metadata.metadata !== 'object') {
    return { metadata: {} };
  }
  
  // Iterate through flat path keys in v2 metadata
  for (const [flatPath, value] of Object.entries(v2Metadata.metadata)) {
    // Match patterns like "path/.zattrs", "path/.zarray", "path/.zgroup"
    const match = flatPath.match(/^(.+?)\/(\.zattrs|\.zarray|\.zgroup)$/);
    if (match) {
      const [, path, metadataType] = match;
      if (!nested[path]) {
        nested[path] = {};
      }
      nested[path][metadataType as '.zattrs' | '.zarray' | '.zgroup'] = value;
    }
  }
  
  return { metadata: nested };
}

// we might not always use the FetchStore, this is for convenience & could change
/**
 * Try to open consolidated metadata from a zarr store.
 * Supports both zarr v2 (.zmetadata) and v3 (zarr.json) formats.
 * There is a tendency for .zmetadata to be misnamed as zmetadata in v2.
 */
export async function tryConsolidated(store: zarr.FetchStore): Promise<IntermediateConsolidatedStore> {
  //!!! nb - we need to also handle local files, in which case we don't fetch(url), we need another method - this is important
  
  // First, try zarr.json (v3 format)
  try {
    const zarrJsonPath = `${store.url}/zarr.json`;
    const zarrJson = await (await fetch(zarrJsonPath)).json();
    const parseResult = await parseZarrJson(zarrJson);
    
    if (!parseResult.ok) {
      // Fall through to try v2 formats
      throw parseResult.error;
    }
    
    const v3Metadata = parseResult.value;
    
    // For v3, zarrita's withConsolidated doesn't work, so we need to implement our own contents()
    // Extract paths from the nested metadata structure
    const paths = new Set<string>();
    if (v3Metadata.metadata && typeof v3Metadata.metadata === 'object') {
      for (const path of Object.keys(v3Metadata.metadata)) {
        paths.add(path);
      }
    }
    const uniquePaths = Array.from(paths);
    
    // For v3, we need to create a listable store
    // Since zarrita's withConsolidated doesn't work for v3, we create our own wrapper
    // that implements contents() based on the metadata we parsed
    const v3ListableStore = Object.assign(store, {
      contents: () => {
        // Return contents based on metadata paths
        return uniquePaths.map(p => {
          const fullPath = p.startsWith('/') ? p : `/${p}`;
          const pathMetadata = v3Metadata.metadata?.[p];
          return {
            path: fullPath as `/${string}`,
            kind: pathMetadata && '.zarray' in pathMetadata ? ('array' as const) : ('group' as const)
          };
        });
      }
    }) as zarr.Listable<zarr.FetchStore>;
    
    return { 
      ...v3ListableStore, 
      zmetadata: v3Metadata,
      metadataFormat: 'v3'
    };
  } catch {
    // Fall through to try v2 formats
  }
  
  // Try .zmetadata (v2 format)
  try {
    const path = `${store.url}/.zmetadata`;
    const zmetadata = await (await fetch(path)).json() as ZarrV2Metadata;
    const zarrita = await zarr.withConsolidated(store);
    // Normalize v2 flat metadata to v3 nested format for consistent internal use
    const v3Metadata = normalizeV2ToV3Metadata(zmetadata);
    return { 
      ...zarrita, 
      zmetadata: v3Metadata,
      metadataFormat: 'v3' // Store as v3 format after normalization
    };
  } catch {
    // Try zmetadata (v2 variant, misnamed)
    try {
      const path = `${store.url}/zmetadata`;
      const zmetadata = await (await fetch(path)).json() as ZarrV2Metadata;
      const zarrita = await zarr.withConsolidated(store, { metadataKey: 'zmetadata' });
      // Normalize v2 flat metadata to v3 nested format for consistent internal use
      const v3Metadata = normalizeV2ToV3Metadata(zmetadata);
      return { 
        ...zarrita, 
        zmetadata: v3Metadata,
        metadataFormat: 'v3' // Store as v3 format after normalization
      };
    } catch {
      throw new Error(
        `Couldn't open consolidated metadata for '${store.url}'. Tried: zarr.json (v3), .zmetadata (v2), and zmetadata (v2 variant). Ensure the store has consolidated metadata enabled.`
      );
    }
  }
}

/**
 * Try to open a consolidated `zarr` store and return a `Result<ConsolidatedStore>`,
 * Supports both zarr v2 and v3 formats.
 */
export async function openExtraConsolidated(source: string): Promise<Result<ConsolidatedStore>> {
  // could `source` also be a File or something?
  try {
    const store = new zarr.FetchStore(source);
    const zarritaStore = await tryConsolidated(store);
    if (!('contents' in zarritaStore)) {
      return Err(new Error(`No consolidated metadata in store '${source}'. The store may not have consolidated metadata enabled.`));
    }
    
    // Validate that we have metadata
    if (!zarritaStore.zmetadata || typeof zarritaStore.zmetadata !== 'object') {
      return Err(new Error(`Invalid consolidated metadata format in store '${source}'. Expected an object but got ${typeof zarritaStore.zmetadata}.`));
    }
    
    const tree = await parseStoreContents(zarritaStore);
    return Ok({ zarritaStore, tree });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    return Err(new Error(`Failed to open consolidated zarr store '${source}': ${errorMessage}`));
  }
}


/**
 * Get zarr attributes from a consolidated store's metadata
 * All metadata is normalized to v3 nested format internally, so we always use nested access
 */
export async function getZattrs(path: zarr.AbsolutePath, store: IntermediateConsolidatedStore, k=".zattrs"): Promise<Record<string, unknown> | undefined> {
  // All metadata is stored in v3 nested format after normalization
  const v3Metadata = store.zmetadata as ZarrV3Metadata;
  const pathStr = path.slice(1); // Remove leading '/'
  const pathMetadata = v3Metadata.metadata?.[pathStr];
  if (!pathMetadata || typeof pathMetadata !== 'object') {
    return undefined;
  }
  
  const attr = pathMetadata[k as '.zattrs' | '.zarray' | '.zgroup'];
  if (!attr) return undefined;
  return attr as Record<string, unknown>;
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

