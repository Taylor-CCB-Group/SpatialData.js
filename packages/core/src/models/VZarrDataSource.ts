// import { zarrOpenRoot } from '@vitessce/zarr-utils';
import { open as zarrOpen, root as zarrRoot } from 'zarrita';
import type { _any } from '../Vutils';
import type { Group, Location, Readable } from 'zarrita';
import { zarrOpenRoot, type DataSourceParams } from '../Vutils';


/**
 * A loader ancestor class containing a default constructor
 * and a stub for the required load() method.
 */
export default class ZarrDataSource {
  storeRoot: Group<Readable> | Location<Readable>;
  /**
   * @param params The parameters object.
   */
  constructor({ url, requestInit, refSpecUrl, store, fileType }: DataSourceParams & { refSpecUrl?: string }) {
    console.info('Using a Zarr-based data source. 403 and 404 HTTP responses for Zarr metadata files (.zattrs, .zarray, .zgroup, zarr.json) are to be expected and do not necessarily indicate errors.');
    if (store) {
      // TODO: check here that it is a valid Zarrita Readable?
      this.storeRoot = zarrRoot(store);
    } else if (url) {
      this.storeRoot = zarrOpenRoot(url, fileType, { requestInit, refSpecUrl });
    } else {
      throw new Error('Either a store or a URL must be provided to the ZarrDataSource constructor.');
    }
  }

  /**
   *
   * @param {string} path
   * @returns {ZarrLocation<Readable>}
   */
  getStoreRoot(path: string): Location<Readable> {
    return this.storeRoot.resolve(path);
  }

  /**
   * Method for accessing JSON attributes, relative to the store root.
   * @param key A path to the item.
   * @param storeRootParam An optional location,
   * which if provided will override the default store root.
   * @returns This async function returns a promise
   * that resolves to the parsed JSON if successful.
   * @throws This may throw an error.
   */
  async getJson(key: string, storeRootParam: Location<Readable> | null = null): Promise<Record<string, _any>> {
    const { storeRoot } = this;
    const storeRootToUse = storeRootParam || storeRoot;

    let dirKey = key;
    // TODO: update calls to not include these file names in the first place.
    if (key.endsWith('.zattrs') || key.endsWith('.zarray') || key.endsWith('.zgroup')) {
      dirKey = key.substring(0, key.length - 8);
    }
    try {
      const location = storeRootToUse.resolve(dirKey);
      const arrOrGroup = await zarrOpen(location);
      return arrOrGroup.attrs;
    } catch (e: unknown) {
      if (e instanceof Error && 'name' in e && e.name === 'NodeNotFoundError') {
        throw new Error(dirKey);
      }
      throw e;
    }
  }
}
