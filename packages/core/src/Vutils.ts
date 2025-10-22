// Direct copy of Vitessce implementation.
// some things from various different places are combined here...
// changes mostly minor error handling & type syntax, not using ZipFileStore for now.
// (would like to use ZipFileStore if it works sensibly, 
// but it caused build issues earlier in MDV and is marked experimental in zarrita.js)


import type { AbsolutePath, Readable } from "zarrita";
import ReferenceStore from '@zarrita/storage/ref';
// import { ZipFileStore } from "zarrita";

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

export function zarrOpenRoot(url: string, fileType?: string, opts?: ZarrOpenRootOptions) {
  let store: Readable;
  if (fileType?.endsWith('.zip')) {
    //note: when I was prototyping use of zarrita in MDV, I had build issues with ZipFileStore.
    //so I'm disabling it here for now pending review. It seemed to work well in dev server...
    throw new Error('ZipFileStore is not supported yet');
    // store = ZipFileStore.fromUrl(url, {
    //   overrides: opts?.requestInit,
    //   transformEntries: transformEntriesForZipFileStore,
    // });
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

