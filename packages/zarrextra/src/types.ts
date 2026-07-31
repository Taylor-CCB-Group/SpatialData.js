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
  [ZARRAY_KEY]: ZarrArrayMetadata;
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
 * Zarr v2 array node metadata, as written to `.zarray`.
 *
 * `dtype` is a numpy typestring (`<f8`, `|b1`, `|O`, `<U16`) — the v2 spelling of
 * what v3 calls `data_type`. Prefer {@link getArrayDtype} over reading either
 * field: it is the only place that knows both spellings, and it answers in
 * `zarrita`'s own `DataType` vocabulary so tree-level and opened-array-level
 * checks cannot drift apart.
 */
export type ZarrV2ArrayNode = {
  shape: number[];
  chunks: number[];
  dtype: string;
  fill_value?: unknown;
  order?: string;
  filters?: unknown[] | null;
  compressor?: unknown;
  dimension_separator?: string;
  zarr_format?: number;
};

/**
 * Zarr v3 array node metadata, as written to `zarr.json`.
 *
 * Only `shape` and `data_type` are required here: the rest are optional in the
 * specification or omitted by real writers, and this type describes metadata as
 * it arrives from a store — parsed, but not validated or normalised. Nothing
 * validates it on the way in, by design: see {@link ZarrArrayMetadata}.
 */
export type ZarrV3ArrayNode = {
  shape: number[];
  data_type: string;
  chunk_grid?: {
    name: string;
    configuration: {
      chunk_shape: number[];
    };
  };
  chunk_key_encoding?: {
    name: string;
    configuration: {
      separator: string;
    };
  };
  fill_value?: number | string | boolean;
  codecs?: Array<{
    name: string;
    configuration?: Record<string, unknown>;
  }>;
  attributes?: Record<string, unknown>;
  dimension_names?: string[];
  zarr_format?: number;
  node_type?: 'array';
  storage_transformers?: unknown[];
};

/**
 * The array metadata a tree leaf carries under {@link ZARRAY_KEY} — one of the
 * two generations, or an unrecognised record.
 *
 * The third member is deliberate rather than sloppy. This is unvalidated JSON
 * straight from the store, and zarr v3 permits data types we do not model (an
 * extension dtype is written as an object, not a string), so a union of only the
 * two known shapes would either be a lie or would have to fail the whole store
 * open. What the union does buy is the compile error that matters: `dtype` is
 * absent from the v3 member and `data_type` from the v2 member, so neither can
 * be read without narrowing — reading `.dtype` off a v3 node and silently
 * getting `undefined` no longer type-checks.
 */
export type ZarrArrayMetadata = ZarrV2ArrayNode | ZarrV3ArrayNode | ZAttrsAny;

/**
 * This type is liable to change in future - for now, it has `zarritaStore` which is the `ListableStore` from `zarrita`,
 * and `tree: ZarrTree` which has the object hierarchy as described in the consolidated metadata as a mostly "Plain Old Javascript Object",
 * but with (weakly typed) `Symbol`-keyed `attrs` & `.zarray` properties where available, and a `get()` on leaf nodes
 * for requesting array data.
 *
 * The use of `Symbol('attrs')` is intended to make these properties easy to access, but not appear when using `Object.keys()` etc.
 */
export type ConsolidatedStore = {
  zarritaStore: zarr.Listable<Store>;
  tree: ZarrTree;
};
