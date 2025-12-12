/**
 * Core type definitions for SpatialData.ts
 * 
 * This file contains the fundamental types that are shared across the codebase.
 * It's designed to avoid circular dependencies by being imported by other modules
 * rather than importing from them.
 * 
 * IMPORTANT: When adding new types here, be careful to:
 * 1. Only import from external libraries (anndata.js, zarrita, etc.)
 * 2. Avoid importing from other modules in this codebase
 * 3. Keep this file focused on pure type definitions
 * 4. Consider whether a type belongs here vs. in a more specific module
 */

// ============================================
// Result Type
// ============================================

/**
 * A Result type for explicit error handling without exceptions.
 * Inspired by Rust's Result<T, E>.
 */
export type Result<T, E = Error> = 
  | { ok: true; value: T }
  | { ok: false; error: E };

/** Create a successful Result */
export const Ok = <T>(value: T): Result<T, never> => ({ ok: true, value });

/** Create a failed Result */
export const Err = <E>(error: E): Result<never, E> => ({ ok: false, error });

/** Type guard for Ok results */
export const isOk = <T, E>(result: Result<T, E>): result is { ok: true; value: T } => result.ok;

/** Type guard for Err results */
export const isErr = <T, E>(result: Result<T, E>): result is { ok: false; error: E } => !result.ok;

/**
 * Unwrap a Result, throwing if it's an error.
 * Use when you want to convert back to exception-based error handling.
 */
export const unwrap = <T, E>(result: Result<T, E>): T => {
  if (result.ok) return result.value;
  throw result.error instanceof Error ? result.error : new Error(String(result.error));
};

/**
 * Unwrap a Result with a default value for errors.
 */
export const unwrapOr = <T, E>(result: Result<T, E>, defaultValue: T): T => {
  return result.ok ? result.value : defaultValue;
};

import type * as ad from 'anndata.js';
import type * as zarr from 'zarrita';
import type { ZarrTree } from '@spatialdata/zarrextra';

/**
 * Element name constants and types
 * 
 * These define the different types of spatial elements that can be stored
 * in a SpatialData object. The distinction between SpatialElementNames and
 * ElementNames is that tables are not considered "spatial" elements in the
 * same way as images, points, labels, and shapes.
 */
export const SpatialElementNames = ['images', 'points', 'labels', 'shapes'] as const;
export const ElementNames = [...SpatialElementNames, 'tables'] as const;
export type ElementName = typeof ElementNames[number];

/**
 * Core data types for different element types
 * 
 * These types represent the actual data structures returned when loading
 * elements from the zarr store. They should be kept in sync with the
 * loader implementations in models/index.ts.
 */
export type Table = ad.AnnData<zarr.Readable<unknown>, zarr.NumberDataType, zarr.Uint32>;
// export type Shapes = {
//   attrs: Record<string, unknown>;
//   loadPolygonShapes: () => Promise<Array<Array<Array<[number, number]>>>>;
//   loadCircleShapes: () => Promise<Array<Array<Array<[number, number]>>>>;
//   loadShapesIndex: () => Promise<Array<number>>;
// };

// Placeholder for elements of a general type pending proper modelling
export type XSpatialElement = Awaited<ReturnType<typeof zarr.open>>;

/**
 * Store location type
 * 
 * Represents where a SpatialData store can be located.
 */
export type StoreLocation = string;

/**
 * Bad file handler type
 * 
 * Callback function type for handling errors when loading files from the store.
 * This allows consumers to define their own error handling strategy.
 */
export type BadFileHandler = (file: string, error: Error) => void;

/**
 * If we support drag 'n' drop loading then presumably this will need to be something different.
 */
type Store = zarr.FetchStore;

/**
 * Zarr group type
 */
export type ZGroup = zarr.Group<Store>;

// Re-export zarr-related types from zarrextra for convenience
// These are used in SDataProps and models, so we keep them accessible from core/types
export type { ZarrTree, LazyZarrArray, ZAttrsAny } from '@spatialdata/zarrextra';
export { ATTRS_KEY, ZARRAY_KEY } from '@spatialdata/zarrextra';


/**
 * Used internally when passing around properties of a spatialdata object to be used by the models/loaders.
 */
export type SDataProps = {
  url: StoreLocation;
  parsed?: ZarrTree;
  onBadFiles?: BadFileHandler;
  selection?: ElementName[];
  rootStore: zarr.Listable<zarr.FetchStore>;
}