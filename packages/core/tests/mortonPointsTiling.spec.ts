import { execSync } from 'node:child_process';
import { mkdtemp, readFile, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import SpatialDataPointsSource from '../src/models/VPointsSource.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, '../../..');
const writerRoot = join(projectRoot, 'python/spatialdata-experimental-writer');

async function writeSyntheticPointsZarr(root: string) {
  const elementDir = join(root, 'points', 'transcripts');
  await mkdir(elementDir, { recursive: true });
  await writeFile(
    join(root, 'zarr.json'),
    JSON.stringify({ zarr_format: 3, node_type: 'group' })
  );
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
    `uv run spatialdata-experimental-writer morton-points-from-zarr ${JSON.stringify(root)} --points-key transcripts --row-group-size 100`,
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
    execSync(`rm -rf ${JSON.stringify(fixtureRoot)}`, { stdio: 'pipe' });
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
    expect(result.loadMode).toBe('row-groups');
    expect(mockStore.getRangeCalls()).toBeGreaterThan(0);
    expect(mockStore.getCalls()).toBe(0);
  });
});
