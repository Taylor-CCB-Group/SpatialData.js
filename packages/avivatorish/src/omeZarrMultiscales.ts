import { loadOmeZarr } from '@hms-dbmi/viv';
import { loadOmeZarrMultiscalesFromStore } from 'zarrextra';

type OmeZarrStore = Parameters<typeof loadOmeZarrMultiscalesFromStore>[0];

export type OmeZarrMultiscalesSource =
  | string
  | {
      url?: string;
      store?: OmeZarrStore;
    };

/** OME-Zarr multiscales pixel sources (no caching). */
export async function loadOmeZarrMultiscalesData(source: OmeZarrMultiscalesSource) {
  if (typeof source !== 'string' && source.store) {
    return loadOmeZarrMultiscalesFromStore(source.store);
  }

  const url = typeof source === 'string' ? source : source.url;
  if (!url) {
    throw new Error('OME-Zarr loading requires either a Zarrita store or a URL.');
  }

  return loadOmeZarr(url, { type: 'multiscales' }).then(({ data }) => data);
}
