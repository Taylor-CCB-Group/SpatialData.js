// Version-matrix coverage for the table/AnnData reading paths.
//
// `fixtures.test.ts` asks whether a store *opens* across releases. This asks
// whether the values come back *right* — which is where successive spatialdata
// releases actually bite, because each one is free to re-encode the same logical
// table. Two changes in 0.8.0 motivated this file, and both are silent: nothing
// throws when they are mishandled, you just get wrong or empty data.
//
//   1. `obs/_index` and `var/_index` became `nullable-string-array` *groups*
//      (a `values` array beside a `mask` array) instead of plain `string-array`
//      arrays. A reader that assumes "the index is an array" finds a group.
//   2. Multiscale dataset paths were renamed `0`/`1`/`2` → `s0`/`s1`/`s2`. A
//      reader that derives level paths positionally rather than reading
//      `multiscales[0].datasets[].path` looks for nodes that are not there.
//
// The obs and var indices reach us by *different* internal routes (`_loadColumn`
// vs `getFlatArrDecompressed`), so both are asserted rather than assuming one
// vouches for the other.

import { FileSystemStore } from '@zarrita/storage';
import { beforeAll, describe, expect, it } from 'vitest';
import SpatialDataTableSource from '../../packages/core/src/models/VTableSource.js';
import { readZarr } from '../../packages/core/src/store/index.js';
import { loadOmeZarrMultiscalesFromStore } from '../../packages/zarrextra/src/index.js';
import { ensureFixtures, FIXTURE_VERSIONS, fixturePath } from './fixtureVersions.js';

/** What `blobs()` contains, and has contained across every release in the matrix. */
const EXPECTED_VAR_NAMES = ['channel_0_sum', 'channel_1_sum', 'channel_2_sum'];
const EXPECTED_REGION = 'blobs_labels';
const EXPECTED_OBS_ROWS = 26;

beforeAll(() => {
  for (const version of FIXTURE_VERSIONS) {
    ensureFixtures(version);
  }
}, 300000);

describe.each(FIXTURE_VERSIONS)('AnnData reading - spatialdata v%s', (version) => {
  let store: FileSystemStore;

  beforeAll(() => {
    store = new FileSystemStore(fixturePath(version));
  });

  it('reads the obs index whatever encoding AnnData wrote it in', async () => {
    const sdata = await readZarr(store);
    const table = sdata.tables?.table;
    expect(table).toBeDefined();
    if (!table) return;

    const index = await table.loadObsIndex();

    // Decoded row labels, not a lazy handle and not the mask/values plumbing:
    // on 0.8.0 the index is a nullable-string-array group, so getting real
    // strings out is the whole point of the assertion.
    expect(index).toHaveLength(EXPECTED_OBS_ROWS);
    expect(index.every((label) => typeof label === 'string' && label.length > 0)).toBe(true);
    expect(new Set(index).size).toBe(EXPECTED_OBS_ROWS);
  }, 30000);

  it('reads the var index, which travels a different route than obs', async () => {
    // No `TableElement.getVarNames()` exists yet, so this goes through the table
    // source directly — the same drop-to-the-source a consumer has to make today.
    const source = new SpatialDataTableSource({ store, fileType: '.zarr' });
    const varNames = await source.loadVarIndex('tables/table');

    expect(varNames).toEqual(EXPECTED_VAR_NAMES);
  }, 30000);

  it('decodes obs columns, including the categorical one', async () => {
    const sdata = await readZarr(store);
    const table = sdata.tables?.table;
    expect(table).toBeDefined();
    if (!table) return;

    const [region, instanceId] = await table.loadObsColumns(['region', 'instance_id']);
    expect(region).toBeDefined();
    expect(instanceId).toBeDefined();
    if (!region || !instanceId) return;

    expect(region).toHaveLength(EXPECTED_OBS_ROWS);
    expect(instanceId).toHaveLength(EXPECTED_OBS_ROWS);

    // `region` is stored as codes + categories; a reader that handed back the
    // raw codes would still be the right length, so assert the decoded label.
    expect(new Set(Array.from(region))).toEqual(new Set([EXPECTED_REGION]));
    expect(Array.from(instanceId, Number).every(Number.isFinite)).toBe(true);
  }, 30000);

  it('reports obs column kinds that match how the columns actually decode', async () => {
    const sdata = await readZarr(store);
    const table = sdata.tables?.table;
    expect(table).toBeDefined();
    if (!table) return;

    expect(table.getObsColumnKinds(['region', 'instance_id'])).toEqual(['categorical', 'numeric']);
    // The index is a row label, not a column, in every encoding it has had.
    expect(table.getObsColumnNames()).not.toContain(table.getObsIndexColumnName());
  }, 30000);
});

describe.each(FIXTURE_VERSIONS)('Known gap: anndata.js var names - spatialdata v%s', (version) => {
  it('does not yield decoded var names, which is why we read the index ourselves', async () => {
    // Characterisation, not endorsement. `getAnnDataJS()` resolves fine, but
    // `varNames()` cannot produce `string[]` for any store in the matrix:
    //
    //   0.5.0 (zarr v2)  returns a lazy `zarr.Array` handle, no decoding
    //   0.6.1 / 0.7.2    throws on the zarr v3 string dtype
    //   0.8.0            throws on the nullable-string-array group
    //
    // The 0.5.0 case is the dangerous one: it *resolves*, so a caller that
    // awaits it gets an object rather than names and silently falls back to
    // `var0`, `var1`, ... . That is why the var-index test above goes through
    // the table source instead. If this test starts failing, anndata.js has
    // grown the support we want and the workaround can be reconsidered.
    const sdata = await readZarr(new FileSystemStore(fixturePath(version)));
    const table = sdata.tables?.table;
    expect(table).toBeDefined();
    if (!table) return;

    const annData = await table.getAnnDataJS();
    expect(annData).toBeDefined();

    let names: unknown;
    try {
      names = await annData.varNames();
    } catch {
      return; // Threw outright — gap confirmed for this version.
    }

    const decoded =
      Array.isArray(names) && names.length > 0 && names.every((n) => typeof n === 'string');
    expect(decoded).toBe(false);
  }, 30000);
});

describe.each(FIXTURE_VERSIONS)('Multiscale level resolution - spatialdata v%s', (version) => {
  it('resolves declared dataset paths to real arrays', async () => {
    const sdata = await readZarr(new FileSystemStore(fixturePath(version)));
    const image = sdata.images?.blobs_multiscale_image;
    expect(image).toBeDefined();
    if (!image) return;

    const levels = image.scaleLevels;
    expect(levels.length).toBeGreaterThan(1);
    expect(image.isMultiscale).toBe(true);

    // The names are whatever the store declares — `0`/`1`/`2` up to 0.7.2,
    // `s0`/`s1`/`s2` from 0.8.0. Pinning either spelling here would be pinning
    // the bug; what must hold is that every name `scaleLevels` reports is a node
    // that exists on disk. A positional fallback would still return three plausible
    // names on 0.8.0, and this is what catches that they address nothing.
    const elementStore = image.getStore();
    for (const level of levels) {
      const metadata = await Promise.all([
        elementStore.get(`/${level}/zarr.json`), // zarr v3
        elementStore.get(`/${level}/.zarray`), // zarr v2
      ]);
      expect(metadata.some((entry) => entry !== undefined)).toBe(true);
    }

    // Coarser levels really are coarser, so the levels are not all the same node.
    const sources = await loadOmeZarrMultiscalesFromStore(elementStore);
    expect(sources).toHaveLength(levels.length);
    const widths = sources.map((source) => source.shape[source.shape.length - 1]);
    for (let i = 1; i < widths.length; i++) {
      expect(widths[i]).toBeLessThan(widths[i - 1]);
    }

    // Each level carries its own scale transform.
    for (const level of levels) {
      expect(image.getTransformationForLevel(level)).toBeDefined();
    }
  }, 30000);
});
