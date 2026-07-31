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
import type { ConsolidatedStore } from 'zarrextra';
import type * as zarr from 'zarrita';

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
export type ElementName = (typeof ElementNames)[number];

/**
 * Core data types for different element types
 *
 * These types represent the actual data structures returned when loading
 * elements from the zarr store. They should be kept in sync with the
 * loader implementations in models/index.ts.
 */
export type Table = ad.AnnData<zarr.Readable, zarr.NumberDataType, zarr.Uint32>;
export type TableValue = string | number | boolean | bigint | null | undefined;
export type TableColumnData = ArrayLike<TableValue> & Iterable<TableValue>;

/**
 * What an obs column *is*, as the store declares it — not as its values happen to
 * look once decoded.
 *
 * The loader already has to distinguish these to decode a column at all (an
 * AnnData categorical is codes plus a categories array; a `string-array` is
 * neither), and until this existed it threw the answer away. Consumers were then
 * left inferring the type back from stringified values, which is both lossy and
 * wrong at the edges: a float column with one `NaN` reads as non-numeric, and
 * integer cluster codes read as a continuum.
 *
 *  - `numeric`     — an integer or float dtype. Orderable; a ramp is meaningful.
 *  - `categorical` — an AnnData categorical (`encoding-type: 'categorical'`), i.e.
 *                    the store itself says these are levels, not quantities.
 *  - `string`      — free text (`string-array`, or an object dtype).
 *  - `boolean`     — a bool dtype. Two levels, so categorical in practice.
 */
export type TableColumnKind = 'numeric' | 'categorical' | 'string' | 'boolean';
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
export type StoreReference = StoreLocation | zarr.Readable;

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
type Store = zarr.Readable;

/**
 * Zarr group type
 */
export type ZGroup = zarr.Group<Store>;

// Re-export zarr-related types from zarrextra for convenience
// These are used in SDataProps and models, so we keep them accessible from core/types
// Re-export Result type and utilities from zarrextra for convenience
// Result is used throughout core for explicit error handling
export type {
  LazyZarrArray,
  Result,
  ZAttrsAny,
  ZarrArrayMetadata,
  ZarrDataType,
  ZarrTree,
  ZarrV2ArrayNode,
  ZarrV3ArrayNode,
} from 'zarrextra';
export {
  ATTRS_KEY,
  Err,
  getArrayDtype,
  getArrayMetadata,
  getChildArray,
  getChildGroup,
  getChildNode,
  getNodeAttrs,
  isErr,
  isLazyZarrArray,
  isOk,
  isTextDataType,
  isZarrGroup,
  normalizeDtype,
  Ok,
  unwrap,
  unwrapOr,
  ZARRAY_KEY,
} from 'zarrextra';

/**
 * Used internally when passing around properties of a spatialdata object to be used by the models/loaders.
 */
export type SDataProps = {
  source: StoreReference;
  url?: StoreLocation;
  onBadFiles?: BadFileHandler;
  selection?: ElementName[];
  rootStore: ConsolidatedStore;
};
export type PointsLoadMode = 'row-groups' | 'full-filter' | 'clipped';
