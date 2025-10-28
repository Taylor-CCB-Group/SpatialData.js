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

import type * as ad from 'anndata.js';
import type * as zarr from 'zarrita';
import type SpatialDataShapesSource from './models/VShapesSource';

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
 * Represents where a SpatialData store can be located - either a URL string
 * or a URL object.
 */
export type StoreLocation = string | URL;

/**
 * Bad file handler type
 * 
 * Callback function type for handling errors when loading files from the store.
 * This allows consumers to define their own error handling strategy.
 */
export type BadFileHandler = (file: string, error: Error) => void;

/**
 * Zarr tree type
 * 
 * This is a tree of zarr arrays and groups, with the leaves being lazy arrays.
 * It is used to represent the structure of the zarr store.
 * Leaf type subject to change.
 */
export type ZGroup = zarr.Group<zarr.FetchStore>;
export type LazyZarrArray<T extends zarr.DataType> = () => Promise<zarr.Array<T>>;
export interface ZarrTree { [key: string]: ZarrTree | LazyZarrArray<zarr.DataType>; };

/**
 * Used internally when passing around properties of a spatialdata object to be used by the models/loaders.
 */
export type SDataProps = {
  url: StoreLocation;
  parsed?: ZarrTree;
  onBadFiles?: BadFileHandler;
  selection?: ElementName[];
}