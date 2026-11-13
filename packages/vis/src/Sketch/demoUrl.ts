/** Default SpatialData Zarr URL for the vis demo / docs Sketch embed. */
export const DEFAULT_DEMO_SPATIALDATA_URL =
  'https://oranus.cmd.ox.ac.uk/publicprojects/project/13/spatial/Atera_v1_WTA_Kidney_non_diseased_FFPE.zarr';

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

/**
 * `?webgpu` (any value but `0`/`false`) runs the demo's deck on WebGPU (experimental).
 */
export function isWebGPURequested(searchParams: URLSearchParams): boolean {
  if (!searchParams.has('webgpu')) return false;
  const value = searchParams.get('webgpu')?.trim().toLowerCase();
  return value !== '0' && value !== 'false';
}

/**
 * `?antialias=0` (or `false`) turns off the WebGL canvas's MSAA, so WebGL can be
 * compared with WebGPU, which deck renders without multisampling.
 */
export function isAntialiasDisabled(searchParams: URLSearchParams): boolean {
  const value = searchParams.get('antialias')?.trim().toLowerCase();
  return value === '0' || value === 'false';
}

/** What the catalog's server found at a store's root; absent when not inspected. */
export type CatalogStoreKind = 'spatialdata' | 'zarr' | 'unknown';

/** One store in a catalog, with its URL made absolute. */
export interface CatalogStore {
  path: string;
  url: string;
  kind?: CatalogStoreKind;
}

const CATALOG_STORE_KINDS: readonly string[] = ['spatialdata', 'zarr', 'unknown'];

function isCatalogStoreKind(value: unknown): value is CatalogStoreKind {
  return typeof value === 'string' && CATALOG_STORE_KINDS.includes(value);
}

/** Why a catalog store will not open as SpatialData, or null if it may. */
export function catalogStoreProblem(store: CatalogStore): string | null {
  if (store.kind === 'zarr') return 'zarr, not SpatialData';
  if (store.kind === 'unknown') return 'no zarr metadata';
  return null;
}

/** `?catalog=` (resolved against the page), or null. Written by `sdjs serve`. */
export function getCatalogUrlFromSearchParams(
  searchParams: URLSearchParams,
  base: string
): string | null {
  const raw = searchParams.get('catalog')?.trim();
  if (!raw) return null;
  try {
    return new URL(raw, base).href;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * Read a store catalog: `{ stores: [{ path, url, kind? }] }`, each `url` relative to
 * the catalog's own URL. Entries that are not of that shape are dropped, and an
 * unrecognised `kind` is ignored.
 */
export function parseCatalog(json: unknown, catalogUrl: string): CatalogStore[] {
  if (!isRecord(json) || !Array.isArray(json.stores)) {
    throw new Error('Not a store catalog: expected { stores: [...] }');
  }
  return json.stores.flatMap((entry: unknown) => {
    if (!isRecord(entry) || typeof entry.path !== 'string' || typeof entry.url !== 'string') {
      return [];
    }
    try {
      const url = new URL(entry.url, catalogUrl).href;
      return [
        { path: entry.path, url, ...(isCatalogStoreKind(entry.kind) && { kind: entry.kind }) },
      ];
    } catch {
      return [];
    }
  });
}
