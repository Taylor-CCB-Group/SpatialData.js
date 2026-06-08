/** spatialdata `blobs()` fixture version served locally during vis demo dev. */
export const LOCAL_BLOBS_FIXTURE_VERSION = '0.7.2';

/**
 * URL for the local `blobs.zarr` fixture.
 *
 * During `pnpm --filter @spatialdata/vis dev`, Vite proxies `/test-fixtures`
 * to the fixture server (started alongside the demo on the host, default port 38473).
 */
export function getLocalBlobsFixtureUrl(origin?: string): string {
  const base = origin ?? (typeof window !== 'undefined' ? window.location.origin : 'http://127.0.0.1:5173');
  return `${base}/test-fixtures/v${LOCAL_BLOBS_FIXTURE_VERSION}/blobs.zarr`;
}
