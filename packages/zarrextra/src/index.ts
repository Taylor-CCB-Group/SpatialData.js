import * as zarr from 'zarrita';
import type { ZarrTree, ConsolidatedStore, ZAttrsAny, IntermediateConsolidatedStore, ZarrV2Metadata, ZarrV3Metadata, ZarrV3GroupNode, ZarrV3ArrayNode } from './types';
import { ATTRS_KEY, ZARRAY_KEY } from './types';
import { Err, Ok, type Result } from './result';

/**
 * As of this writing, this returns a nested object, leaf nodes have async functions that return the zarr array.
 * 
 * This traverses arbitrary group depth etc - handy for a generic zarr thing, but for SpatialData we can have
 * something more explicitly targetting the expected structure.
 * 
 * Works directly with the normalized v3 metadata structure, extracting paths from metadata rather than
 * relying on store.contents().
 */
async function parseStoreContents(store: IntermediateConsolidatedStore): Promise<ZarrTree> {
  // Access metadata from consolidated_metadata.metadata
  const metadata = store.zmetadata.consolidated_metadata?.metadata;
  
  if (!metadata || typeof metadata !== 'object') {
    return {};
  }
  
  // Extract all paths from metadata and determine their types
  const pathInfo = new Map<string, { isArray: boolean; path: string; node: ZarrV3GroupNode | ZarrV3ArrayNode }>();
  
  for (const [path, node] of Object.entries(metadata)) {
    if (node && typeof node === 'object' && 'node_type' in node) {
      const isArray = node.node_type === 'array';
      pathInfo.set(path, { isArray, path, node });
    }
  }
  
  // Sort paths by depth (shorter paths first) to build tree top-down
  const sortedPaths = Array.from(pathInfo.entries()).sort((a, b) => {
    const depthA = a[0].split('/').filter(p => p).length;
    const depthB = b[0].split('/').filter(p => p).length;
    return depthA - depthB;
  });
  
  // Open root for resolving array paths later
  // this is throwing when I try to open http://localhost:8081/?url=https://s3.embl.de/spatialdata/spatialdata-sandbox/xenium_rep2_io.zarr
  // it gets to `open_group_v2`, `throw new NodeNotFoundError("v2 group", ...)`
  // ... but also, if I open that sample with python spatialdata 0.6.1 or 0.5.0, it also fails, in different ways.
  // thinking about compiling a table of results from the examples on the website...
  const root = await zarr.open(store, { kind: 'group' });
  
  const tree: ZarrTree = {};
  
  for (const [fullPath, info] of sortedPaths) {
    // Skip root path
    if (!fullPath || fullPath === '/' || fullPath === '') continue;
    
    // Normalize path: ensure it starts with / and doesn't end with /
    const normalizedPath = fullPath.startsWith('/') ? fullPath : `/${fullPath}`;
    const pathParts = normalizedPath.split('/').filter(p => p);
    
    if (pathParts.length === 0) continue;
    
    let currentNode = tree;
    
    // Build tree structure
    for (const [i, part] of pathParts.entries()) {
      if (!(part in currentNode)) {
        const isLeaf = i === pathParts.length - 1;
        const isArray = isLeaf && info.isArray;
        
        // Get attributes for this path (normalizedPath already has leading /)
        const attrs = getZattrs(normalizedPath as zarr.AbsolutePath, store);
        
        if (isArray) {
          // Leaf array node - extract array metadata from the node
          const arrayNode = info.node as ZarrV3ArrayNode;
          const zarray: ZAttrsAny = {
            shape: arrayNode.shape,
            data_type: arrayNode.data_type,
            chunk_grid: arrayNode.chunk_grid,
            chunk_key_encoding: arrayNode.chunk_key_encoding,
            fill_value: arrayNode.fill_value,
            codecs: arrayNode.codecs,
            dimension_names: arrayNode.dimension_names,
            zarr_format: arrayNode.zarr_format,
            node_type: arrayNode.node_type,
            storage_transformers: arrayNode.storage_transformers,
          };
          
          currentNode[part] = {
            [ATTRS_KEY]: attrs,
            [ZARRAY_KEY]: zarray,
            get: () => zarr.open(root.resolve(normalizedPath), { kind: 'array' })
          };
        } else {
          // Group node
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
 * The actual zarr v3 structure has metadata nested under consolidated_metadata.metadata
 * We normalize it to have a top-level metadata field for internal use.
 */
async function parseZarrJson(zarrJson: unknown): Promise<Result<ZarrV3Metadata, Error>> {
  if (!zarrJson || typeof zarrJson !== 'object') {
    return Err(new Error(`Invalid zarr.json: expected an object but got ${typeof zarrJson}`));
  }
  
  const parsed = zarrJson as ZarrV3Metadata;
  
  // Validate the structure
  if (!parsed.consolidated_metadata || typeof parsed.consolidated_metadata !== 'object') {
    return Err(new Error('Invalid zarr.json: consolidated_metadata field is missing or not an object'));
  }
  
  if (!parsed.consolidated_metadata.metadata || typeof parsed.consolidated_metadata.metadata !== 'object') {
    return Err(new Error('Invalid zarr.json: consolidated_metadata.metadata field is missing or not an object'));
  }
  
  // Return the parsed structure as-is (it matches our type definition)
  return Ok(parsed);
}

/**
 * Normalize zarr v2 flat metadata to v3 structure
 * Converts flat structure like { "path/.zattrs": {...}, "path/.zarray": {...} } 
 * to v3 structure with consolidated_metadata.metadata containing nodes
 */
function normalizeV2ToV3Metadata(v2Metadata: ZarrV2Metadata): ZarrV3Metadata {
  const metadata: Record<string, ZarrV3GroupNode | ZarrV3ArrayNode> = {};
  
  if (!v2Metadata.metadata || typeof v2Metadata.metadata !== 'object') {
    return {
      attributes: {},
      zarr_format: 3,
      consolidated_metadata: {
        kind: 'inline',
        must_understand: false,
        metadata: {}
      },
      node_type: 'group'
    };
  }
  
  // Group paths by their base path (without .zattrs, .zarray, .zgroup suffix)
  const pathGroups = new Map<string, { zattrs?: unknown; zarray?: unknown; zgroup?: unknown }>();
  
  // Iterate through flat path keys in v2 metadata
  for (const [flatPath, value] of Object.entries(v2Metadata.metadata)) {
    // Match patterns like "path/.zattrs", "path/.zarray", "path/.zgroup"
    const match = flatPath.match(/^(.+?)\/(\.zattrs|\.zarray|\.zgroup)$/);
    if (match) {
      const [, path, metadataType] = match;
      if (!pathGroups.has(path)) {
        pathGroups.set(path, {});
      }
      const group = pathGroups.get(path);
      if (group) {
        if (metadataType === '.zattrs') {
          group.zattrs = value;
        } else if (metadataType === '.zarray') {
          group.zarray = value;
        } else if (metadataType === '.zgroup') {
          group.zgroup = value;
        }
      }
    }
  }
  
  // Convert grouped paths to v3 node structure
  for (const [path, group] of pathGroups.entries()) {
    if (group.zarray) {
      // Array node - use zarray metadata as the base
      const zarray = group.zarray as Record<string, unknown>;
      metadata[path] = {
        shape: (zarray.shape as number[]) || [],
        data_type: (zarray.data_type as string) || 'float64',
        chunk_grid: (zarray.chunk_grid as ZarrV3ArrayNode['chunk_grid']) || {
          name: 'regular',
          configuration: { chunk_shape: [] }
        },
        chunk_key_encoding: (zarray.chunk_key_encoding as ZarrV3ArrayNode['chunk_key_encoding']) || {
          name: 'default',
          configuration: { separator: '/' }
        },
        fill_value: (zarray.fill_value as number | string | boolean) || 0,
        codecs: (zarray.codecs as ZarrV3ArrayNode['codecs']) || [],
        attributes: (group.zattrs as Record<string, unknown>) || {},
        dimension_names: (zarray.dimension_names as string[]) || [],
        zarr_format: (zarray.zarr_format as number) || 3,
        node_type: 'array',
        storage_transformers: (zarray.storage_transformers as unknown[]) || []
      };
    } else {
      // Group node
      metadata[path] = {
        attributes: (group.zattrs as Record<string, unknown>) || {},
        zarr_format: 3,
        consolidated_metadata: {
          kind: 'inline',
          must_understand: false,
          metadata: {}
        },
        node_type: 'group'
      };
    }
  }
  
  return {
    attributes: {},
    zarr_format: 3,
    consolidated_metadata: {
      kind: 'inline',
      must_understand: false,
      metadata
    },
    node_type: 'group'
  };
}

// we might not always use the FetchStore, this is for convenience & could change
/**
 * Try to open consolidated metadata from a zarr store.
 * Supports both zarr v2 (.zmetadata) and v3 (zarr.json) formats.
 * There is a tendency for .zmetadata to be misnamed as zmetadata in v2.
 * 
 * Since we work directly with metadata and don't use contents(), we don't need
 * zarrita's withConsolidated() - we just fetch the metadata files and normalize them.
 */
async function tryConsolidated(store: zarr.FetchStore): Promise<IntermediateConsolidatedStore> {
  //!!! nb - we need to also handle local files, in which case we don't fetch(url), we need another method - this is important
  
  // Normalize base URL to avoid double slashes when constructing metadata paths
  const urlString = typeof store.url === 'string' ? store.url : store.url.toString();
  const baseUrl = urlString;
  
  // First, try zarr.json (v3 format)
  try {
    const zarrJsonPath = `${baseUrl.replace(/\/+$/, '')}/zarr.json`;
    const zarrJson = await (await fetch(zarrJsonPath)).json();
    const parseResult = await parseZarrJson(zarrJson);
    
    if (!parseResult.ok) {
      // Fall through to try v2 formats
      throw parseResult.error;
    }
    
    const v3Metadata = parseResult.value;
    
    // Return store with metadata properties
    return Object.assign(store, {
      zmetadata: v3Metadata
    });
  } catch {
    // Fall through to try v2 formats
  }
  
  // Try .zmetadata (v2 format)
  try {
    const path = `${baseUrl.replace(/\/+$/, '')}/.zmetadata`;
    const zmetadata = await (await fetch(path)).json() as ZarrV2Metadata;
    // Normalize v2 flat metadata to v3 nested format for consistent internal use
    const v3Metadata = normalizeV2ToV3Metadata(zmetadata);
    // Return store with metadata properties
    return Object.assign(store, {
      zmetadata: v3Metadata
    });
  } catch {
    // Try zmetadata (v2 variant, misnamed)
    try {
      const path = `${baseUrl.replace(/\/+$/, '')}/zmetadata`;
      const zmetadata = await (await fetch(path)).json() as ZarrV2Metadata;
      // Normalize v2 flat metadata to v3 nested format for consistent internal use
      const v3Metadata = normalizeV2ToV3Metadata(zmetadata);
      // Return store with metadata properties
      return Object.assign(store, {
        zmetadata: v3Metadata,
        metadataFormat: 'v3' as const
      });
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
    // Normalize source to avoid trailing slashes causing double-slash paths
    const normalizedSource = source.replace(/\/+$/, '');

    // why does this later end up thinking it should be able to do use HTTPMethd.PUT? 
    // seems inappropriate for a read-only store.
    const store = new zarr.FetchStore(normalizedSource);
    const zarritaStore = await tryConsolidated(store);
    // Validate that we have metadata (we no longer check for contents() since we don't use it)
    
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
 * In zarr v3, attributes are stored in the `attributes` field of each node
 */
function getZattrs(path: zarr.AbsolutePath, store: IntermediateConsolidatedStore, k=".zattrs"): Record<string, unknown> | undefined {
  const pathStr = path.slice(1); // Remove leading '/'
  const metadata = store.zmetadata.consolidated_metadata?.metadata;
  if (!metadata || typeof metadata !== 'object') {
    return undefined;
  }
  
  const node = metadata[pathStr];
  if (!node || typeof node !== 'object' || !('node_type' in node)) {
    return undefined;
  }
  
  // For backward compatibility, if k is ".zattrs", return the attributes field
  // Otherwise, this function might be called with ".zarray" but in v3 we don't need that
  // since array metadata is in the node itself
  if (k === '.zattrs') {
    return node.attributes;
  }
  
  // For other keys, return undefined (legacy support)
  return undefined;
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

