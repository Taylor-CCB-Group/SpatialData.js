import { execSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The spatialdata releases we generate `blobs` fixtures from, and test against.
 *
 * Each entry needs a matching `python/v<version>/` environment (pyproject.toml +
 * generate_fixtures.py); `python/scripts/generate_fixtures.py` is the orchestrator
 * that runs them. Adding a version here without adding the environment makes
 * `ensureFixtures` fail with the orchestrator's own "Script not found" error.
 *
 * These are not redundant copies of one store: each release writes `blobs` a
 * little differently, and the differences are exactly what the readers must
 * absorb. 0.8.0, for instance, renamed multiscale dataset paths (`0` → `s0`) and
 * moved the AnnData dataframe index to a nullable-string-array *group*.
 *
 * ## What this matrix does not cover
 *
 * A version here names a spatialdata release, but that is not what determines
 * the bytes. Each `python/v<version>/` environment pins spatialdata and lets
 * everything else float, so a fixture is really spatialdata-X against whatever
 * anndata / zarr / pyarrow / geopandas its lock resolved on the day. Both halves
 * of that have bitten us: bumping pyarrow rewrote every parquet file (same data,
 * different container), and bumping anndata broke generation outright on
 * spatialdata < 0.8.0. So each row is *one sample* from a much larger writer
 * space, not a characterisation of the release.
 *
 * Permuting that space — spatialdata × anndata × zarr × pyarrow × ... — is not
 * the fix. It multiplies ~70s of generation per cell for a combinatorial number
 * of cells, and still would not be exhaustive, because the writers keep shipping
 * new versions. It also aims at the wrong target: we do not care which writer
 * combination produced a store, only which *encodings* end up in it.
 *
 * So treat this matrix as a discovery mechanism rather than a proof: it is how we
 * find out that an encoding exists in the wild. Once found, the encoding itself
 * belongs in a cheap, writer-independent unit test against a hand-built tree,
 * which costs no fixture generation and keeps holding when the writers move
 * again. `packages/core/tests/nullableStringArray.spec.ts` is the worked example
 * — it pins the nullable-string-array index that 0.8.0 introduced without
 * generating anything — and `tableElement.spec.ts` does the same for the obs
 * column-kind classifier across both zarr generations.
 *
 * Adding a row here is worth it when a release changes the on-disk format. It is
 * not worth it as routine version bookkeeping, and it is not a substitute for
 * pinning the encoding.
 */
export const FIXTURE_VERSIONS = ['0.5.0', '0.6.1', '0.7.2', '0.8.0'] as const;

export type FixtureVersion = (typeof FIXTURE_VERSIONS)[number];

/** The newest release in the matrix — what docs and single-version jobs should track. */
export const CURRENT_FIXTURE_VERSION: FixtureVersion =
  FIXTURE_VERSIONS[FIXTURE_VERSIONS.length - 1];

export const projectRoot = join(dirname(fileURLToPath(import.meta.url)), '../..');

/** Path of the `blobs.zarr` store for a version, whether or not it exists yet. */
export function fixturePath(version: string): string {
  return join(projectRoot, 'test-fixtures', `v${version}`, 'blobs.zarr');
}

/**
 * Generate the `blobs` fixture for a version if it is not already on disk.
 *
 * CI normally restores these from cache and this is a no-op; locally it is what
 * makes a fresh clone able to run the integration suite unattended.
 */
export function ensureFixtures(version: string): string {
  const path = fixturePath(version);
  if (existsSync(path)) {
    return path;
  }

  console.log(`Fixtures not found for version ${version}, generating...`);
  const uvCacheDir = join(projectRoot, '.tmp', 'uv-cache');
  try {
    mkdirSync(uvCacheDir, { recursive: true });
    execSync(`uv run python/scripts/generate_fixtures.py --version ${version}`, {
      cwd: projectRoot,
      env: { ...process.env, UV_CACHE_DIR: uvCacheDir },
      stdio: 'inherit',
    });
  } catch (error) {
    throw new Error(
      `Failed to generate fixtures for version ${version}. ` +
        `Make sure uv is installed and spatialdata is available. Error: ${error}`
    );
  }

  return path;
}
