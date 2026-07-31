import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { FileSystemStore } from '@zarrita/storage';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  type AnyElement,
  readZarr,
  type SpatialData,
} from '../../packages/core/src/store/index.js';
import { fixtureServerOrigin } from '../../scripts/fixture-server-port.mjs';
import {
  CURRENT_FIXTURE_VERSION,
  ensureFixtures,
  FIXTURE_VERSIONS,
  fixturePath,
  projectRoot,
} from './fixtureVersions.js';

function getFirstElement(sdata: SpatialData): AnyElement | undefined {
  for (const elementType of ['images', 'labels', 'points', 'shapes', 'tables'] as const) {
    const collection = sdata[elementType];
    if (collection && Object.keys(collection).length > 0) {
      return Object.values(collection)[0];
    }
  }
  return undefined;
}

beforeAll(() => {
  for (const version of FIXTURE_VERSIONS) {
    ensureFixtures(version);
  }
}, 300000);

describe.each(FIXTURE_VERSIONS)('Integration Tests - spatialdata v%s (file store)', (version) => {
  let fixtureStore: FileSystemStore;

  beforeAll(() => {
    fixtureStore = new FileSystemStore(fixturePath(version));
  });

  it('should load spatialdata store from a FileSystemStore', async () => {
    const sdata = await readZarr(fixtureStore);
    expect(sdata).toBeDefined();
    expect(sdata.source).toBe(fixtureStore);
    expect(sdata.url).toBeUndefined();
    expect(sdata.rootStore.tree).toBeDefined();
  }, 30000);

  it('reads obs column kinds synchronously, from consolidated metadata alone', async () => {
    // The load-bearing assumption behind `getObsColumnKinds` being sync: opening a
    // store already pulls every node's attributes and array metadata into the tree.
    // Unit tests assert the classifier against a mock tree — this asserts the tree
    // really carries what the classifier reads, across both zarr generations, and
    // would catch a zarrextra change that silently stopped populating it.
    const sdata = await readZarr(fixtureStore);
    const table = sdata.tables?.table;
    expect(table).toBeDefined();
    if (!table) return;

    const names = table.getObsColumnNames();
    const kinds = table.getObsColumnKinds(names);

    expect(kinds[names.indexOf('instance_id')]).toBe('numeric');
    expect(kinds[names.indexOf('region')]).toBe('categorical');
    expect(kinds).toHaveLength(names.length);
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
  const version = CURRENT_FIXTURE_VERSION;
  let fixtureUrl: string;

  beforeAll(() => {
    ensureFixtures(version);
    fixtureUrl = `${fixtureServerOrigin('localhost')}/v${version}/blobs.zarr`;
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
          'Skipping HTTP smoke test - test server not running. Start it with: pnpm test:server'
        );
        return;
      }
      throw error;
    }
  }, 30000);
});

describe('Fixture Generation', () => {
  it('should generate fixtures for all versions', () => {
    for (const version of FIXTURE_VERSIONS) {
      if (existsSync(fixturePath(version))) {
        console.log(`using existing fixture for ${version}`);
      } else {
        ensureFixtures(version);
      }
      expect(existsSync(join(projectRoot, 'test-fixtures', `v${version}`))).toBe(true);
    }
  }, 90000);
});
