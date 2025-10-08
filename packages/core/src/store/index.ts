/**
 * Store interface for reading SpatialData from zarr stores
 */

import * as zarr from 'zarrita';
// import type { SpatialData } from '../schemas/index.js';
// import { spatialDataSchema } from '../schemas/index.js';

type StoreLocation = string | URL;

const ElementNames = ['images', 'points', 'labels', 'shapes', 'tables'];

export class SpatialData {
  readonly url: StoreLocation;
  initPromise: Promise<void>;
  constructor(url: StoreLocation, selection?: string[], onBadFiles?: BadFileHandler) {
    this.url = url;
    this.initPromise = this.init();
  }
  async init() {
    const store = new zarr.FetchStore(this.url);
    const group = await zarr.tryWithConsolidated(store);
    const root = await zarr.open(group, { kind: 'group' });

  }
}

export type BadFileHandler = (file: string, error: Error) => void;

export async function readZarr(storeUrl: StoreLocation, selection?: string[], onBadFiles?: BadFileHandler) {
  const sdata = new SpatialData(storeUrl);
  await sdata.init();
  return sdata;
}


/**
 * Read data from a specific array in the SpatialData store
 * @param storeUrl - URL to the zarr store
 * @param arrayPath - Path to the array within the store
 * @returns Promise resolving to the array
 */
export async function readArray(storeUrl: string, arrayPath: string) {
  const store = new zarr.FetchStore(storeUrl);
  const location = zarr.root(store).resolve(arrayPath);
  return await zarr.open(location, { kind: 'array' });
}
