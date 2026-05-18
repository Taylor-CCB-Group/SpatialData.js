/** Default SpatialData Zarr URL for the vis demo / docs Sketch embed. */
export const DEFAULT_DEMO_SPATIALDATA_URL =
  'https://storage.googleapis.com/vitessce-demo-data/spatialdata-august-2025/visium_hd_3.0.0.spatialdata.zarr';

/**
 * Read `?url=` from a query string (e.g. for MDV links into the demo).
 * Returns `fallback` when the param is missing or blank.
 */
export function getSpatialDataUrlFromSearchParams(
  searchParams: URLSearchParams,
  fallback: string = DEFAULT_DEMO_SPATIALDATA_URL
): string {
  const raw = searchParams.get('url');
  if (raw == null) {
    return fallback;
  }
  const trimmed = raw.trim();
  if (trimmed === '') {
    return fallback;
  }
  try {
    return decodeURIComponent(trimmed);
  } catch {
    return trimmed;
  }
}

/** Build a demo page href with the given SpatialData store URL in `?url=`. */
export function buildDemoPageHref(
  spatialDataUrl: string,
  base: string | URL = typeof window !== 'undefined'
    ? window.location.href
    : 'http://127.0.0.1:5173/'
): string {
  const page = new URL(base);
  page.searchParams.set('url', spatialDataUrl);
  return page.href;
}
