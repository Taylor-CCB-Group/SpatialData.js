import { loadOmeZarr } from '@hms-dbmi/viv';

/** OME-Zarr multiscales pixel sources for a URL (no caching). */
export async function loadOmeZarrMultiscalesData(url: string): Promise<unknown> {
  const loader = await loadOmeZarr(url, { type: 'multiscales' });
  return loader.data;
}
