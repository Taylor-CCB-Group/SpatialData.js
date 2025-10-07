/**
 * Store interface for reading SpatialData from zarr stores
 */

import { FetchStore, open, root } from 'zarrita';
import type { SpatialData } from '../schemas/index.js';
import { spatialDataSchema } from '../schemas/index.js';

/**
 * Opens a SpatialData store
 * @param storeUrl - URL to the zarr store
 * @returns Promise resolving to the store metadata
 */
export async function openSpatialDataStore(storeUrl: string): Promise<SpatialData> {
  const store = new FetchStore(storeUrl);
  const group = await open(store, { kind: 'group' });
  const attrs = group.attrs;

  // Validate and parse the metadata using zod schema
  return spatialDataSchema.parse(attrs);
}

/**
 * Read data from a specific array in the SpatialData store
 * @param storeUrl - URL to the zarr store
 * @param arrayPath - Path to the array within the store
 * @returns Promise resolving to the array
 */
export async function readArray(storeUrl: string, arrayPath: string) {
  const store = new FetchStore(storeUrl);
  const location = root(store).resolve(arrayPath);
  return await open(location, { kind: 'array' });
}
