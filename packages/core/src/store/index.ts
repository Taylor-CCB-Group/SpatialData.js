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
  console.log(attrs);

  // Validate and parse the metadata using zod schema
  // this is what is actually returned:
  // {
  //     "spatialdata_attrs": {
  //         "spatialdata_software_version": "0.3.1.dev0+gae71ae1.d20250414",
  //         "version": "0.1"
  //     }
  // }
  // we need to get rid of the nonsense vibe-code and write some actual code.
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
