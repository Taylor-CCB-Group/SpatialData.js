import type * as zarr from 'zarrita';

/**
 * If we support drag 'n' drop loading then presumably this will need to be something different.
 */
type Store = zarr.FetchStore;

/**
 * Zarr attributes type - a record of string keys to unknown values
 */
export type ZAttrsAny = Record<string, unknown>;

/**
 * Symbol key for storing zarr attributes in the tree structure
 */
export const ATTRS_KEY = Symbol('attrs');

/**
 * Symbol key for storing zarr array metadata
 */
export const ZARRAY_KEY = Symbol('.zarray');

/**
 * Lazy zarr array type - represents a zarr array with a `get()` method for loading it,
 * and `.zarray` from consolidated metadata.
 */
export type LazyZarrArray<T extends zarr.DataType> = {
  [ATTRS_KEY]?: ZAttrsAny;
  [ZARRAY_KEY]: ZAttrsAny;
  get: () => Promise<zarr.Array<T>>;
};

/**
 * Zarr tree type
 * 
 * This is a tree of zarr arrays and groups, with the leaves being lazy arrays.
 * It is used to represent the structure of the zarr store.
 * Leaf type subject to change.
 */
export interface ZarrTree {
  [ATTRS_KEY]?: ZAttrsAny;
  [key: string]: ZarrTree | LazyZarrArray<zarr.DataType>;
}

/**
 * Zarr v2 consolidated metadata structure (.zmetadata)
 * Has a flat metadata object with path keys like "path/.zattrs"
 */
export type ZarrV2Metadata = {
  metadata: Record<string, unknown>;
};

/**
 * Zarr v3 array node metadata
 */
export type ZarrV3ArrayNode = {
  shape: number[];
  data_type: string;
  chunk_grid: {
    name: string;
    configuration: {
      chunk_shape: number[];
    };
  };
  chunk_key_encoding: {
    name: string;
    configuration: {
      separator: string;
    };
  };
  fill_value: number | string | boolean;
  codecs: Array<{
    name: string;
    configuration?: Record<string, unknown>;
  }>;
  attributes: Record<string, unknown>;
  dimension_names: string[];
  zarr_format: number;
  node_type: 'array';
  storage_transformers: unknown[];
};

/**
 * Zarr v3 group node metadata
 */
export type ZarrV3GroupNode = {
  attributes: Record<string, unknown>;
  zarr_format: number;
  consolidated_metadata: {
    kind: string;
    must_understand: boolean;
    metadata: Record<string, unknown>;
  };
  node_type: 'group';
};

/**
 * Zarr v3 consolidated metadata structure (zarr.json)
 * The actual structure has metadata nested under consolidated_metadata.metadata
 * with path keys like "images/blobs_image", "labels/blobs_labels", etc.
 * Each entry can be either a group node or an array node.
 */
export type ZarrV3Metadata = {
  attributes: Record<string, unknown>;
  zarr_format: number;
  consolidated_metadata: {
    kind: string;
    must_understand: boolean;
    metadata: Record<string, ZarrV3GroupNode | ZarrV3ArrayNode>;
  };
  node_type: 'group';
};

/**
 * Union type for consolidated metadata (v2 or v3)
 */
export type ConsolidatedMetadata = ZarrV2Metadata | ZarrV3Metadata;

/**
 * Discriminated union to identify metadata format
 */
export type MetadataFormat = 
  | { format: 'v2'; metadata: ZarrV2Metadata }
  | { format: 'v3'; metadata: ZarrV3Metadata };

/**
 * A zarrita store with metadata appended as `zmetadata` - mostly for internal use and subject to revision.
 * For zarr v3, metadata is in the actual structure with consolidated_metadata.metadata.
 * For zarr v2, we normalize it to match the v3 structure internally.
 * Uses `Store` (FetchStore) which already implements `Readable` - we work directly with metadata
 * and don't need `contents()` from `Listable`.
 */
export type IntermediateConsolidatedStore = Store & { 
  zmetadata: ZarrV3Metadata;
};
/**
 * This type is liable to change in future - for now, it has `zarritaStore` which is the `ListableStore` from `zarrita`, 
 * and `tree: ZarrTree` which has the object hierarchy as described in the consolidated metadata as a mostly "Plain Old Javascript Object",
 * but with (weakly typed) `Symbol`-keyed `attrs` & `.zarray` properties where available, and a `get()` on leaf nodes
 * for requesting array data.
 * 
 * The use of `Symbol('attrs')` is intended to make these properties easy to access, but not appear when using `Object.keys()` etc.
 */
export type ConsolidatedStore = {
  zarritaStore: IntermediateConsolidatedStore,
  tree: ZarrTree
}