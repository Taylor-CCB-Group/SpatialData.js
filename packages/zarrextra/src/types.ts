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
 * Lazy zarr array type - represents a zarr array that hasn't been loaded yet
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
export type ConsolidatedStore = zarr.Listable<Store> & { zmetadata: any };

