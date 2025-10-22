// Direct copy of Vitessce implementation.
// some things from various different places are combined here...
// (ie file-types/zarr/ utils & zarr-utils/normalize.ts)

import type { AbsolutePath, Readable } from "zarrita";
import ReferenceStore from '@zarrita/storage/ref';
import ZipFileStore from "@zarrita/storage/zip";
import type { ZipInfo } from 'unzipit';
import { FetchStore } from "@zarrita/storage";
import { root as zarrRoot } from "zarrita";
/**
 * Returns the directory part of a path,
 * (before the last '/' character).
 */
export function dirname(path: string) {
  const arr = path.split('/');
  arr.pop();
  return arr.join('/');
}

/**
 * Returns the last part of a path,
 * (after the last '/' character).
 */
export function basename(path: string) {
  const arr = path.split('/');
  const result = arr.at(-1);
  if (!result) {
    console.error('basename of path is empty', path);
    return '';
  }
  return result;
}
type ZarrOpenRootOptions = {
  requestInit?: RequestInit,
  refSpecUrl?: string,
};

export type DataSourceParams = {
  url?: string;
  /** Options to pass to fetch calls. */
  requestInit?: RequestInit;
  /** A Zarrita store object. */
  store?: Readable;
  /** The file type. */
  fileType: string; // '.zip' | '.h5ad' etc...
}


class RelaxedFetchStore extends FetchStore {
  // This allows returning `undefined` for 403 responses,
  // as opposed to completely erroring.
  // Needed due to https://github.com/manzt/zarrita.js/pull/212
  // In the future, perhaps we could contribute a way to pass a
  // custom error handling function or additional options
  // to the zarrita FetchStore so that a subclass is not required.
  async get(
    key: AbsolutePath,
    options: RequestInit = {},
  ): Promise<Uint8Array | undefined> {
    try {
      return await super.get(key, options);
    } catch (e: unknown) {
      // TODO: request/contribute a custom error class
      // to avoid string comparisons in the future.
      if (
        //@ts-ignore messy error handling...
        e?.message?.startsWith('Unexpected response status 403')
        && !true//getDebugMode()
      ) {
        return undefined;
      }
      throw e;
    }
  }
}
// Define a transformEntries function that expects a single top-level .zarr directory
// and strips that prefix from all entries.
export function transformEntriesForZipFileStore(entries: ZipInfo['entries']) {
  // Find all top-level directories that end with .zarr
  const topLevelZarrDirectories = new Set(
    Object.keys(entries)
      .map(k => k.split('/')[0])
      .filter(firstPathItem => firstPathItem?.endsWith('.zarr')),
  );
  if (topLevelZarrDirectories.size === 0) {
    return entries;
  }
  // Check that there is exactly one such directory.
  if (topLevelZarrDirectories.size > 1) {
    throw Error('expected exactly one top-level .zarr directory');
  }
  const topLevelZarrDirectory = Array.from(topLevelZarrDirectories)[0];
  // Modify the entries to strip the top-level .zarr directory prefix from paths.
  const newEntries = Object.fromEntries(
    Object.entries(entries).map(([k, v]) => {
      let newKey = k;
      if (k.split('/')[0] === topLevelZarrDirectory) {
        // Use substring to remove the top-level directory name
        // and the following slash from the internal zip paths.
        newKey = k.substring(topLevelZarrDirectory.length + 1);
      }
      return [newKey, v];
    }),
  );
  return newEntries;
}

export function zarrOpenRoot(url: string, fileType?: string, opts?: ZarrOpenRootOptions) {
  let store: Readable;
  if (fileType?.endsWith('.zip')) {
    //note: when I was prototyping use of zarrita in MDV, I had build issues with ZipFileStore.
    //seems to be building ok here, so keeping it around but would be good to keep in mind.
    store = ZipFileStore.fromUrl(url, {
      overrides: opts?.requestInit,
      transformEntries: transformEntriesForZipFileStore,
    });
  }
  if (fileType?.endsWith('.h5ad')) {
    if (!opts?.refSpecUrl) {
      throw new Error('refSpecUrl is required for H5AD files');
    }
    const referenceSpecPromise = fetch(opts.refSpecUrl)
      .then(res => res.json())
      .then(referenceSpec => Object.fromEntries(
        // We want ReferenceStore.fromSpec to use our `target` URL option regardless
        // of what target URL(s) are specified in the reference spec JSON.
        // Reference: https://github.com/manzt/zarrita.js/pull/155
        Object.entries(referenceSpec as Record<string, unknown>).map(([key, entry]) => {
          if (Array.isArray(entry) && entry.length >= 1) {
            entry[0] = null;
          }
          return [key, entry];
        }),
      ));
    store = ReferenceStore.fromSpec(referenceSpecPromise,
      { target: url, overrides: opts?.requestInit });
  } else {
    store = new RelaxedFetchStore(url, { overrides: opts?.requestInit });
  }

  // Wrap remote stores in a cache
  return zarrRoot(store);
}

