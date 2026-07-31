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
