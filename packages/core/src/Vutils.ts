// Direct copy of Vitessce implementation.
// some things from various different places are combined here...
// (ie file-types/zarr/ utils & zarr-utils/normalize.ts)

import type { Readable } from "zarrita";
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

export type DataSourceParams = {
  url?: string;
  /** Options to pass to fetch calls. */
  requestInit?: RequestInit;
  /** A Zarrita store object. */
  store?: Readable;
  /** The file type. */
  fileType: string; // '.zip' | '.h5ad' etc...
}
