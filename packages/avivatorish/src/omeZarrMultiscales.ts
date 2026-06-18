import { loadOmeZarr } from '@hms-dbmi/viv';
import { loadOmeZarrMultiscalesFromStore } from 'zarrextra';

export type OmeZarrMultiscalesSource =
  | string
  | {
      url?: string;
      store?: unknown;
    };

/** OME-Zarr multiscales pixel sources (no caching). */
export async function loadOmeZarrMultiscalesData(
  source: OmeZarrMultiscalesSource
): Promise<unknown> {
  if (typeof source !== 'string' && source.store) {
    return await loadOmeZarrMultiscalesFromStore(
      source.store as Parameters<typeof loadOmeZarrMultiscalesFromStore>[0]
    );
  }

  const url = typeof source === 'string' ? source : source.url;
  if (!url) {
    throw new Error('OME-Zarr loading requires either a Zarrita store or a URL.');
  }

  const loader = await loadOmeZarr(url, { type: 'multiscales' });
  return loader.data;
}
