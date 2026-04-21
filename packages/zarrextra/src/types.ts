import type * as zarr from 'zarrita';

/**
 * Supported inputs for opening a store.
 */
export type StoreReference = string | zarr.Readable;

type Store = zarr.Readable;

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
 * This type is liable to change in future - for now, it has `zarritaStore` which is the `ListableStore` from `zarrita`, 
 * and `tree: ZarrTree` which has the object hierarchy as described in the consolidated metadata as a mostly "Plain Old Javascript Object",
 * but with (weakly typed) `Symbol`-keyed `attrs` & `.zarray` properties where available, and a `get()` on leaf nodes
 * for requesting array data.
 * 
 * The use of `Symbol('attrs')` is intended to make these properties easy to access, but not appear when using `Object.keys()` etc.
 */
export type ConsolidatedStore = {
  zarritaStore: zarr.Listable<Store>,
  tree: ZarrTree
}
