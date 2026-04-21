import { beforeAll, describe, expect, it } from 'vitest';
import { FileSystemStore } from '@zarrita/storage';
import { readZarr, type SpatialData, type AnyElement } from '../../packages/core/src/store/index.js';
import { execSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectRoot = join(__dirname, '../..');
const uvCacheDir = join(projectRoot, '.tmp', 'uv-cache');

function ensureFixtures(version: string): string {
  const fixturePath = join(projectRoot, 'test-fixtures', `v${version}`, 'blobs.zarr');

  if (!existsSync(fixturePath)) {
    console.log(`Fixtures not found for version ${version}, generating...`);
    try {
      mkdirSync(uvCacheDir, { recursive: true });
      execSync(`uv run python/scripts/generate_fixtures.py --version ${version}`, {
        cwd: projectRoot,
        env: {
          ...process.env,
          UV_CACHE_DIR: uvCacheDir,
        },
        stdio: 'inherit',
      });
    } catch (error) {
      throw new Error(
        `Failed to generate fixtures for version ${version}. ` +
        `Make sure uv is installed and spatialdata is available. Error: ${error}`,
      );
    }
  }

  return fixturePath;
}

function getFirstElement(sdata: SpatialData): AnyElement | undefined {
  for (const elementType of ['images', 'labels', 'points', 'shapes', 'tables'] as const) {
    const collection = sdata[elementType];
    if (collection && Object.keys(collection).length > 0) {
      return Object.values(collection)[0];
    }
  }
  return undefined;
}

const versions = ['0.5.0', '0.6.1', '0.7.2'] as const;

beforeAll(() => {
  for (const version of versions) {
    ensureFixtures(version);
  }
}, 300000);

describe.each(versions)('Integration Tests - spatialdata v%s (file store)', (version) => {
  let fixturePath: string;
  let fixtureStore: FileSystemStore;

  beforeAll(() => {
    fixturePath = join(projectRoot, 'test-fixtures', `v${version}`, 'blobs.zarr');
    fixtureStore = new FileSystemStore(fixturePath);
  });

  it('should load spatialdata store from a FileSystemStore', async () => {
    const sdata = await readZarr(fixtureStore);
    expect(sdata).toBeDefined();
    expect(sdata.source).toBe(fixtureStore);
    expect(sdata.url).toBeUndefined();
    expect(sdata.rootStore.tree).toBeDefined();
  }, 30000);

  it('should parse elements from the file-backed store and expose path identities', async () => {
    const sdata = await readZarr(fixtureStore);

    const hasImages = sdata.images !== undefined && Object.keys(sdata.images).length > 0;
    const hasPoints = sdata.points !== undefined && Object.keys(sdata.points).length > 0;
    const hasShapes = sdata.shapes !== undefined && Object.keys(sdata.shapes).length > 0;
    const hasLabels = sdata.labels !== undefined && Object.keys(sdata.labels).length > 0;
    const hasTables = sdata.tables !== undefined && Object.keys(sdata.tables).length > 0;

    expect(hasImages || hasPoints || hasShapes || hasLabels || hasTables).toBe(true);

    const element = getFirstElement(sdata);
    expect(element).toBeDefined();
    expect(element?.path).toContain('/');
    expect(element?.url).toBeUndefined();
  }, 30000);

  it('should resolve coordinate systems from a file-backed store', async () => {
    const sdata = await readZarr(fixtureStore);
    const coordinateSystems = sdata.coordinateSystems;
    expect(Array.isArray(coordinateSystems)).toBe(true);
    expect(coordinateSystems.length).toBeGreaterThan(0);
  }, 30000);

  it('should have a stable string representation for store-backed loads', async () => {
    const sdata = await readZarr(fixtureStore);
    const str = sdata.toString();

    expect(typeof str).toBe('string');
    expect(str.length).toBeGreaterThan(0);
    expect(str).toContain('SpatialData object');
    expect(str).toContain('[store instance]');
  }, 30000);

  it('should load tables through anndata.js from a prefixed store', async () => {
    const sdata = await readZarr(fixtureStore);
    const table = sdata.tables ? Object.values(sdata.tables)[0] : undefined;

    if (!table) {
      console.warn(`Skipping AnnData integration test for ${version} - no tables found`);
      return;
    }

    await expect(table.getAnnDataJS()).resolves.toBeDefined();
  }, 30000);
});

describe('Integration Tests - HTTP smoke test', () => {
  const version = '0.7.2';
  let fixtureUrl: string;

  beforeAll(() => {
    ensureFixtures(version);
    fixtureUrl = `http://localhost:8080/v${version}/blobs.zarr`;
  });

  it('should still load a spatialdata store over HTTP', async () => {
    try {
      const sdata = await readZarr(fixtureUrl);
      expect(sdata).toBeDefined();
      expect(sdata.url).toBe(fixtureUrl);

      const element = getFirstElement(sdata);
      expect(element).toBeDefined();
      expect(element?.url).toContain(fixtureUrl);
    } catch (error) {
      if (error instanceof Error && error.message.includes('fetch')) {
        console.warn(
          'Skipping HTTP smoke test - test server not running. ' +
          'Start it with: pnpm test:server',
        );
        return;
      }
      throw error;
    }
  }, 30000);
});

describe('Fixture Generation', () => {
  it('should generate fixtures for all versions', () => {
    const v050Path = join(projectRoot, 'test-fixtures', 'v0.5.0', 'blobs.zarr');
    const v061Path = join(projectRoot, 'test-fixtures', 'v0.6.1', 'blobs.zarr');
    const v072Path = join(projectRoot, 'test-fixtures', 'v0.7.2', 'blobs.zarr');

    if (!existsSync(v050Path)) {
      ensureFixtures('0.5.0');
    } else {
      console.log('using existing fixture for 0.5.0');
    }
    if (!existsSync(v061Path)) {
      ensureFixtures('0.6.1');
    } else {
      console.log('using existing fixture for 0.6.1');
    }
    if (!existsSync(v072Path)) {
      ensureFixtures('0.7.2');
    } else {
      console.log('using existing fixture for 0.7.2');
    }

    expect(existsSync(join(projectRoot, 'test-fixtures', 'v0.5.0'))).toBe(true);
    expect(existsSync(join(projectRoot, 'test-fixtures', 'v0.6.1'))).toBe(true);
    expect(existsSync(join(projectRoot, 'test-fixtures', 'v0.7.2'))).toBe(true);
  }, 90000);
});
