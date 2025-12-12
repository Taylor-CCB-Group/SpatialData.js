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
 * A zarrita store with the raw metadata appended as `zmetadata` - mostly for internal use and subject to revision.
 */
export type IntermediateConsolidatedStore = zarr.Listable<Store> & { zmetadata: any };
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