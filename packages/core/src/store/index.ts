/**
 * Store interface for reading SpatialData from zarr stores
 */

import * as zarr from 'zarrita';
// import type { SpatialData } from '../schemas/index.js';
// import { spatialDataSchema } from '../schemas/index.js';

type StoreLocation = string | URL;

const ElementNames = ['images', 'points', 'labels', 'shapes', 'tables'] as const;
type ElementName = typeof ElementNames[number];
// not the actual type we want
type SpatialElement = Awaited<ReturnType<typeof zarr.open>>;

export class SpatialData {
  readonly url: StoreLocation;
  initPromise: Promise<void>;
  images?: SpatialElement;
  points?: SpatialElement;
  labels?: SpatialElement;
  shapes?: SpatialElement;
  tables?: SpatialElement;
  constructor(url: StoreLocation, selection?: ElementName[], onBadFiles?: BadFileHandler) {
    this.url = url;
    this.initPromise = this.init(selection);
  }
  async init(selection?: ElementName[]) {
    const store = new zarr.FetchStore(this.url);
    const root = await zarr.open(store, { kind: 'group' });
    const elementsToLoad = selection ?? ElementNames;
    await Promise.allSettled([
      ...elementsToLoad.map(async (elementName) => {
        this[elementName] = await zarr.open(root.resolve(elementName), { kind: 'group' });
      })
    ]);
  }
  /**
   * Generates a string represntation of the SpatialData object, similar to the Python __repr__ method.
   */
  toString() {
    const nonEmptyElements = ElementNames.filter((name) => this[name] !== undefined);
    if (nonEmptyElements.length === 0) {
      return `SpatialData object, with asssociated Zarr store: ${this.url}\n(No elements loaded)`;
    }
    const elements = nonEmptyElements.map((name) => {
      const element = this[name];
      if (element) {
        const desc = element.kind === 'array' ? ` shape=${element.shape}` : ` attrs=${element.attrs ? JSON.stringify(element.attrs) : '{}'}`;
        return `  └── ${name}: ${element.constructor.name} ${desc}`;
      }
      return `- ${name}: not loaded`;
    }).join('\n');
    return `SpatialData object, with asssociated Zarr store: ${this.url}\nElements:\n${elements}`;
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
