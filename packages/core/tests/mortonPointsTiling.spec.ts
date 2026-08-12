import { execSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import SpatialDataPointsSource from '../src/models/VPointsSource.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, '../../..');
const writerRoot = join(projectRoot, 'python/spatialdata-js-util');

async function writeSyntheticPointsZarr(root: string) {
  const elementDir = join(root, 'points', 'transcripts');
  await mkdir(elementDir, { recursive: true });
  await writeFile(join(root, 'zarr.json'), JSON.stringify({ zarr_format: 3, node_type: 'group' }));
  await writeFile(
    join(elementDir, 'zarr.json'),
    JSON.stringify({
      attributes: {
        'encoding-type': 'ngff:points',
        axes: ['x', 'y'],
        spatialdata_attrs: {
          feature_key: 'feature_name',
          version: '0.2',
        },
      },
      zarr_format: 3,
      node_type: 'group',
    })
  );

  execSync(
    `uv run python - <<'PY'
import pandas as pd
import pyarrow as pa
import pyarrow.parquet as pq
from pathlib import Path

root = Path(${JSON.stringify(elementDir)})
rows = 500
df = pd.DataFrame(
    {
        "x": [float(i % 100) for i in range(rows)],
        "y": [float((i * 3) % 100) for i in range(rows)],
        "feature_name": (["gene_a", "gene_b", "gene_c"] * rows)[:rows],
    }
)
pq.write_table(pa.Table.from_pandas(df, preserve_index=False), root / "points.parquet")
PY`,
    { cwd: writerRoot, stdio: 'pipe' }
  );

  execSync(
    `uv run spatialdata-js-util points morton-from-zarr ${JSON.stringify(root)} --points-key transcripts --row-group-size 100`,
    { cwd: writerRoot, stdio: 'pipe' }
  );
}

async function writeBadSentinelMortonPointsZarr(root: string) {
  const elementDir = join(root, 'points', 'transcripts');
  await mkdir(elementDir, { recursive: true });
  await writeFile(join(root, 'zarr.json'), JSON.stringify({ zarr_format: 3, node_type: 'group' }));
  await writeFile(
    join(elementDir, 'zarr.json'),
    JSON.stringify({
      attributes: {
        'encoding-type': 'ngff:points',
        axes: ['x', 'y'],
        spatialdata_attrs: {
          feature_key: 'feature_name',
          version: '0.2',
        },
      },
      zarr_format: 3,
      node_type: 'group',
    })
  );

  execSync(
    `uv run python - <<'PY'
import pandas as pd
import pyarrow as pa
import pyarrow.parquet as pq
from pathlib import Path

root = Path(${JSON.stringify(elementDir)})
df = pd.DataFrame(
    {
        "x": [0.0, 100.0, 0.1, 0.2, 0.3, 20.0, 40.0],
        "y": [0.0, 100.0, 0.1, 0.2, 0.3, 20.0, 40.0],
        "feature_name_codes": [0, 1, 0, 0, 0, 1, 1],
        "morton_code_2d": [0, 0, 0, 0, 0, 100, 200],
        "feature_name": ["gene_a", "gene_b", "gene_a", "gene_a", "gene_a", "gene_b", "gene_b"],
    }
)
table = pa.Table.from_pandas(df, preserve_index=False)
writer = pq.ParquetWriter(root / "points.parquet", table.schema, compression="zstd")
try:
    writer.write_table(table.slice(0, 5), row_group_size=5)
    writer.write_table(table.slice(5), row_group_size=2)
finally:
    writer.close()
PY`,
    { cwd: writerRoot, stdio: 'pipe' }
  );
}

/**
 * A well-formed Morton artifact in every respect EXCEPT that its sentinel rows record
 * a sub-box of the domain the codes were quantised against — the exact shape of the
 * stale `index-permutations` fixture. The codes are internally consistent, the row
 * groups are sorted, the sentinel prefix is the right size: nothing but recomputing a
 * code from x/y can tell that the box is a lie.
 */
async function writeMismatchedSentinelMortonPointsZarr(root: string) {
  const elementDir = join(root, 'points', 'transcripts');
  await mkdir(elementDir, { recursive: true });
  await writeFile(join(root, 'zarr.json'), JSON.stringify({ zarr_format: 3, node_type: 'group' }));
  await writeFile(
    join(elementDir, 'zarr.json'),
    JSON.stringify({
      attributes: {
        'encoding-type': 'ngff:points',
        axes: ['x', 'y'],
        spatialdata_attrs: {
          feature_key: 'feature_name',
          version: '0.2',
        },
      },
      zarr_format: 3,
      node_type: 'group',
    })
  );

  execSync(
    `uv run python - <<'PY'
import numpy as np
import pandas as pd
import pyarrow as pa
import pyarrow.parquet as pq
from pathlib import Path

from spatialdata_js_util.points import morton_code_2d, _norm_series_to_uint

root = Path(${JSON.stringify(elementDir)})
rows = 400
rng = np.random.default_rng(0)
x = rng.uniform(0.0, 1000.0, rows)
y = rng.uniform(0.0, 1000.0, rows)
df = pd.DataFrame({"x": x, "y": y})
# Codes quantised against the TRUE extent, as a real writer would.
df["morton_code_2d"] = morton_code_2d(
    _norm_series_to_uint(df["x"], float(x.min()), float(x.max())),
    _norm_series_to_uint(df["y"], float(y.min()), float(y.max())),
)
df["feature_name_codes"] = np.arange(rows) % 3
df["feature_name"] = pd.Categorical(["gene_a", "gene_b", "gene_c"] * (rows // 3) + ["gene_a"])
df = df.sort_values("morton_code_2d", kind="mergesort").reset_index(drop=True)

# Sentinels claiming a sub-box: a quarter of the extent, in the middle.
sentinel = pd.DataFrame(
    {
        "x": [250.0, 750.0, 400.0, 600.0],
        "y": [400.0, 600.0, 250.0, 750.0],
        "morton_code_2d": np.zeros(4, dtype=np.uint32),
        "feature_name_codes": np.zeros(4, dtype=np.int32),
        "feature_name": pd.Categorical(["gene_a"] * 4, categories=["gene_a", "gene_b", "gene_c"]),
    }
)
combined = pd.concat([sentinel, df], ignore_index=True)
table = pa.Table.from_pandas(combined, preserve_index=False)
writer = pq.ParquetWriter(root / "points.parquet", table.schema, compression="zstd")
try:
    writer.write_table(table.slice(0, 4), row_group_size=4)
    writer.write_table(table.slice(4), row_group_size=200)
finally:
    writer.close()
PY`,
    { cwd: writerRoot, stdio: 'pipe' }
  );
}

/**
 * A feature-primary artifact: sorted `(feature, morton)`, written by the real writer.
 * Every column the probe looks for is present, the sentinel box is correct, the codes
 * are correct — only the ORDER is wrong for a bisect, and nothing in the file says so.
 */
async function writeFeaturePrimaryMortonPointsZarr(root: string) {
  const elementDir = join(root, 'points', 'transcripts');
  await mkdir(elementDir, { recursive: true });
  await writeFile(join(root, 'zarr.json'), JSON.stringify({ zarr_format: 3, node_type: 'group' }));
  await writeFile(
    join(elementDir, 'zarr.json'),
    JSON.stringify({
      attributes: {
        'encoding-type': 'ngff:points',
        axes: ['x', 'y'],
        spatialdata_attrs: { feature_key: 'feature_name', version: '0.2' },
      },
      zarr_format: 3,
      node_type: 'group',
    })
  );

  execSync(
    `uv run python - <<'PY'
import numpy as np
import pandas as pd

from spatialdata_js_util.points import write_morton_points_parquet

rng = np.random.default_rng(1)
rows = 900
df = pd.DataFrame(
    {
        "x": rng.uniform(0.0, 1000.0, rows),
        "y": rng.uniform(0.0, 1000.0, rows),
        "feature_name": pd.Categorical(rng.choice(["gene_a", "gene_b", "gene_c"], rows)),
    }
)
write_morton_points_parquet(
    df,
    ${JSON.stringify(join(elementDir, 'points.parquet'))},
    feature_key="feature_name",
    sort_order=["feature_name_codes", "morton_code_2d"],
    row_group_size=100,
)
PY`,
    { cwd: writerRoot, stdio: 'pipe' }
  );
}

function createStore(files: Record<string, Uint8Array>) {
  let getRangeCalls = 0;
  let getCalls = 0;
  const store = {
    getRangeCalls: () => getRangeCalls,
    getCalls: () => getCalls,
    resetCalls: () => {
      getRangeCalls = 0;
      getCalls = 0;
    },
    store: {
      async get(path: string) {
        getCalls += 1;
        return files[path.slice(1)] ?? null;
      },
      async getRange(
        path: string,
        range: { offset?: number; length?: number; suffixLength?: number }
      ) {
        getRangeCalls += 1;
        const bytes = files[path.slice(1)];
        if (!bytes) {
          return null;
        }
        if (range.suffixLength !== undefined) {
          const start = Math.max(0, bytes.length - range.suffixLength);
          return bytes.slice(start);
        }
        const offset = range.offset ?? 0;
        const length = range.length ?? bytes.length - offset;
        return bytes.slice(offset, offset + length);
      },
    },
  };
  return store;
}

describe('Morton points tiling (canonical parquet)', () => {
  let fixtureRoot: string;
  let source: SpatialDataPointsSource;
  let mockStore: ReturnType<typeof createStore>;

  beforeAll(async () => {
    fixtureRoot = await mkdtemp(join(tmpdir(), 'morton-points-'));
    await writeSyntheticPointsZarr(fixtureRoot);

    const parquetPath = join(fixtureRoot, 'points/transcripts/points.parquet');
    const elementJsonPath = join(fixtureRoot, 'points/transcripts/zarr.json');
    mockStore = createStore({
      'points/transcripts/points.parquet': new Uint8Array(await readFile(parquetPath)),
      'points/transcripts/zarr.json': new Uint8Array(await readFile(elementJsonPath)),
    });

    source = new SpatialDataPointsSource({
      store: mockStore.store,
      fileType: '.zarr',
    });
  }, 120_000);

  afterAll(async () => {
    await rm(fixtureRoot, { recursive: true, force: true });
  });

  it('detects morton tiling metadata on canonical points.parquet', async () => {
    mockStore.resetCalls();
    const metadata = await source.getPointsTilingMetadata('points/transcripts');
    expect(metadata).toMatchObject({
      kind: 'morton-points',
      featureCodeColumnName: 'feature_name_codes',
    });
    expect(mockStore.getRangeCalls()).toBeGreaterThan(0);
  });

  /**
   * The bisect index must describe each row group's FULL span.
   *
   * `readParquetRowGroupColumnExtent` used to read the last value with
   * `readParquetRowGroup(..., { offset: rowCount - 1, limit: 1 })`, which the vendored
   * parquet-wasm ignores — it returned the first row again, so every row group
   * reported `max === min`. Nothing failed; the bisect just answered "first row group
   * whose max >= target" one group too late and never read the group that actually
   * CONTAINED the target. On a real 12.1M-point artifact that dropped 11 of 92 row
   * groups from a viewport query — 188k points, rendered as Z-order-shaped holes.
   *
   * So this asserts an exact count, not "more than zero": under-selection is silent
   * by construction, and only a total can see it.
   */
  it('returns every point inside the bounds, not just those in some row groups', async () => {
    const full = await source.loadPoints('points/transcripts');
    const xs = full.data[0];
    const ys = full.data[1];
    const minX = Math.min(...xs);
    const minY = Math.min(...ys);
    // A rectangle deliberately spanning several row groups' Morton ranges.
    const bounds = { minX: minX + 10, maxX: minX + 80, minY: minY + 10, maxY: minY + 80 };

    let expected = 0;
    for (let i = 0; i < xs.length; i += 1) {
      if (
        xs[i] >= bounds.minX &&
        xs[i] <= bounds.maxX &&
        ys[i] >= bounds.minY &&
        ys[i] <= bounds.maxY
      ) {
        expected += 1;
      }
    }
    expect(expected).toBeGreaterThan(0);

    const result = await source.loadPointsInBounds('points/transcripts', { bounds });

    expect(result.loadMode).toBe('row-groups');
    expect(result.shape[1]).toBe(expected);
  });

  /**
   * Per-point feature codes ride the tile batch (D5 step 3).
   *
   * Without them a tiled layer has nothing to colour by, so it drew flat while the
   * preloaded path drew per-feature — the same element looking like two different
   * datasets depending on a checkbox. The scan already READ this column to filter on
   * it and threw the value away.
   *
   * Alignment is the contract worth pinning: index i of the codes names the feature
   * of point i in the geometry, so the count must match exactly and every code must
   * be one the catalog knows.
   */
  it('returns a feature code per point, aligned with the geometry', async () => {
    const full = await source.loadPoints('points/transcripts');
    const xs = full.data[0];
    const ys = full.data[1];
    const minX = Math.min(...xs);
    const minY = Math.min(...ys);
    const bounds = { minX: minX + 10, maxX: minX + 80, minY: minY + 10, maxY: minY + 80 };

    const result = await source.loadPointsInBounds('points/transcripts', { bounds });
    const pointCount = result.shape[1] ?? 0;
    expect(pointCount).toBeGreaterThan(0);

    expect(result.featureCodes).toBeDefined();
    expect(result.featureCodes?.length).toBe(pointCount);

    // The fixture has three genes, so every code is a real catalog entry — never the
    // -1 "unknown feature" sentinel, and never a stray 0 left by a short buffer.
    const catalog = await source.listPointsFeaturesWithCounts('points/transcripts');
    const known = new Set((catalog?.entries ?? []).map((entry) => entry.code));
    expect(known.size).toBeGreaterThan(0);
    for (let i = 0; i < pointCount; i += 1) {
      expect(known.has(result.featureCodes?.[i] as number)).toBe(true);
    }
  });

  it('still returns codes when a feature filter is active, for the filtered rows only', async () => {
    const catalog = await source.listPointsFeaturesWithCounts('points/transcripts');
    const wanted = catalog?.entries[0]?.code;
    expect(wanted).toBeDefined();

    const full = await source.loadPoints('points/transcripts');
    const minX = Math.min(...full.data[0]);
    const minY = Math.min(...full.data[1]);
    const bounds = { minX: minX + 10, maxX: minX + 80, minY: minY + 10, maxY: minY + 80 };

    const result = await source.loadPointsInBounds('points/transcripts', {
      bounds,
      featureCodes: [wanted as number],
    });
    const pointCount = result.shape[1] ?? 0;

    expect(result.featureCodes?.length).toBe(pointCount);
    for (let i = 0; i < pointCount; i += 1) {
      expect(result.featureCodes?.[i]).toBe(wanted);
    }
  });

  // The bisect index is built lazily, under exactly the load that duplicates it:
  // every viewport tile bisects concurrently over the same row groups. Caching only
  // the settled value dedups nothing while a read is in flight, so each tile used to
  // start its own full row-group fetch for an entry the others were already fetching.
  it('dedups concurrent extent probes for the same row group', async () => {
    const parquetPath = 'points/transcripts/points.parquet';
    const freshSource = () =>
      new SpatialDataPointsSource({ store: mockStore.store, fileType: '.zarr' });

    const single = freshSource();
    mockStore.resetCalls();
    const expected = await single.loadParquetRowGroupColumnExtent(parquetPath, 'morton_code_2d', 1);
    const singleCallCount = mockStore.getRangeCalls();
    expect(singleCallCount).toBeGreaterThan(0);

    const concurrent = freshSource();
    mockStore.resetCalls();
    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        concurrent.loadParquetRowGroupColumnExtent(parquetPath, 'morton_code_2d', 1)
      )
    );

    // Eight callers, one read.
    expect(mockStore.getRangeCalls()).toBe(singleCallCount);
    for (const result of results) {
      expect(result).toEqual(expected);
    }
  });

  it('loads a bounded viewport without returning the full table', async () => {
    const full = await source.loadPoints('points/transcripts');
    const xs = full.data[0];
    const ys = full.data[1];
    const minX = Math.min(...xs);
    const maxX = Math.max(...xs);
    const minY = Math.min(...ys);
    const maxY = Math.max(...ys);
    const bounds = {
      minX: minX + 5,
      maxX: minX + 15,
      minY: minY + 5,
      maxY: minY + 15,
    };

    mockStore.resetCalls();
    const loadTable = vi.spyOn(source, 'loadParquetTable');
    const result = await source.loadPointsInBounds('points/transcripts', { bounds });
    expect(result.shape[1]).toBeGreaterThan(0);
    expect(result.shape[1]).toBeLessThan(full.shape[1]);
    expect(['row-groups', 'full-filter']).toContain(result.loadMode);
    if (result.loadMode === 'full-filter') {
      expect(loadTable).toHaveBeenCalled();
    }
    loadTable.mockRestore();
  });

  it('filters loaded points by feature codes', async () => {
    const full = await source.loadPoints('points/transcripts');
    const xs = full.data[0];
    const ys = full.data[1];
    const bounds = {
      minX: Math.min(...xs),
      maxX: Math.max(...xs),
      minY: Math.min(...ys),
      maxY: Math.max(...ys),
    };

    const unfiltered = await source.loadPointsInBounds('points/transcripts', { bounds });
    const filtered = await source.loadPointsInBounds('points/transcripts', {
      bounds,
      featureCodes: [0],
    });
    expect(filtered.shape[1]).toBeGreaterThan(0);
    expect(filtered.shape[1]).toBeLessThan(unfiltered.shape[1] ?? Number.MAX_SAFE_INTEGER);
  });

  it('uses row-group reads when parquet-wasm exposes row-group APIs', async () => {
    const canRowGroups = await source.canLoadParquetRowGroups();
    if (!canRowGroups) {
      return;
    }

    const metadata = await source.getPointsTilingMetadata('points/transcripts');
    expect(metadata?.supportsRowGroupRangeReads).toBe(true);
    expect(metadata?.bounds).toBeDefined();

    mockStore.resetCalls();
    const bounds = {
      minX: metadata!.bounds!.minX + 10,
      maxX: metadata!.bounds!.minX + 30,
      minY: metadata!.bounds!.minY + 10,
      maxY: metadata!.bounds!.minY + 30,
    };
    const result = await source.loadPointsInBounds('points/transcripts', { bounds });
    expect(result.shape?.[1]).toBeGreaterThan(0);
    if (result.loadMode === 'row-groups') {
      expect(mockStore.getRangeCalls()).toBeGreaterThan(0);
      expect(mockStore.getCalls()).toBe(0);
    }
  });

  it('does not enable morton tiling when sentinel row group is oversized', async () => {
    const badFixtureRoot = await mkdtemp(join(tmpdir(), 'bad-morton-points-'));
    try {
      await writeBadSentinelMortonPointsZarr(badFixtureRoot);
      const parquetPath = join(badFixtureRoot, 'points/transcripts/points.parquet');
      const elementJsonPath = join(badFixtureRoot, 'points/transcripts/zarr.json');
      const badStore = createStore({
        'points/transcripts/points.parquet': new Uint8Array(await readFile(parquetPath)),
        'points/transcripts/zarr.json': new Uint8Array(await readFile(elementJsonPath)),
      });
      const badSource = new SpatialDataPointsSource({
        store: badStore.store,
        fileType: '.zarr',
      });

      const metadata = await badSource.getPointsTilingMetadata('points/transcripts');

      expect(metadata?.supportsRowGroupRangeReads).toBe(false);
      expect(metadata?.bounds).toBeUndefined();
    } finally {
      execSync(`rm -rf ${JSON.stringify(badFixtureRoot)}`, { stdio: 'pipe' });
    }
  });

  /**
   * The sentinel box is a claim the artifact makes about itself. Believing a wrong one
   * does not fail — it silently clips the tile grid and mis-maps every viewport to row
   * groups, so parts of the map are never even requested. Refuse to tile instead.
   */
  it('does not enable morton tiling when the sentinel bbox is not the code domain', async () => {
    const badFixtureRoot = await mkdtemp(join(tmpdir(), 'mismatched-morton-points-'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await writeMismatchedSentinelMortonPointsZarr(badFixtureRoot);
      const badStore = createStore({
        'points/transcripts/points.parquet': new Uint8Array(
          await readFile(join(badFixtureRoot, 'points/transcripts/points.parquet'))
        ),
        'points/transcripts/zarr.json': new Uint8Array(
          await readFile(join(badFixtureRoot, 'points/transcripts/zarr.json'))
        ),
      });
      const badSource = new SpatialDataPointsSource({ store: badStore.store, fileType: '.zarr' });

      const metadata = await badSource.getPointsTilingMetadata('points/transcripts');

      // Same degradation as every other unusable artifact: the resolver's probe gate
      // reads this pair as "not tileable" and falls through to the capped preload.
      expect(metadata?.supportsRowGroupRangeReads).toBe(false);
      expect(metadata?.bounds).toBeUndefined();
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('sentinel bounding box'));
    } finally {
      warn.mockRestore();
      execSync(`rm -rf ${JSON.stringify(badFixtureRoot)}`, { stdio: 'pipe' });
    }
  });

  /**
   * The bisect binary-searches the row-group Morton index, which only means anything
   * if it ascends. On a feature-primary file it does not, and the search lands
   * arbitrarily: a tile comes back holding whichever feature blocks happened to be in
   * the row groups it picked, and missing the rest.
   */
  it('does not enable morton tiling on a feature-primary artifact', async () => {
    const featureFirstRoot = await mkdtemp(join(tmpdir(), 'feature-primary-points-'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await writeFeaturePrimaryMortonPointsZarr(featureFirstRoot);
      const featureFirstStore = createStore({
        'points/transcripts/points.parquet': new Uint8Array(
          await readFile(join(featureFirstRoot, 'points/transcripts/points.parquet'))
        ),
        'points/transcripts/zarr.json': new Uint8Array(
          await readFile(join(featureFirstRoot, 'points/transcripts/zarr.json'))
        ),
      });
      const source = new SpatialDataPointsSource({
        store: featureFirstStore.store,
        fileType: '.zarr',
      });

      const metadata = await source.getPointsTilingMetadata('points/transcripts');

      expect(metadata?.supportsRowGroupRangeReads).toBe(false);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('not sorted across row groups'));
      // No bounds either: the sort verdict short-circuits the sampling read that would
      // verify the sentinel box, and an unverified box is exactly what we stopped
      // reporting. Nothing consumes bounds without supportsRowGroupRangeReads anyway.
      expect(metadata?.bounds).toBeUndefined();
    } finally {
      warn.mockRestore();
      execSync(`rm -rf ${JSON.stringify(featureFirstRoot)}`, { stdio: 'pipe' });
    }
  });
});
