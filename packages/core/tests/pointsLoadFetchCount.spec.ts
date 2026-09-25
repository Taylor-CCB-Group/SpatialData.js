import { execSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import SpatialDataPointsSource from '../src/models/VPointsSource.js';
import SpatialDataTableSource, { MAX_PARQUET_PARTS } from '../src/models/VTableSource.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const writerRoot = join(__dirname, '../../../python/spatialdata-js-util');

const ELEMENT_PATH = 'points/blobs_points';
const PARQUET_DIR = `${ELEMENT_PATH}/points.parquet`;
const PART_0 = `${PARQUET_DIR}/part.0.parquet`;
const ROWS = 5000;

type StoreCall = { op: 'GET' | 'RANGE'; path: string };

/**
 * A filesystem store that records every read, so a test can count the requests a
 * load actually makes rather than inspecting cache internals (AGENTS.md: observe
 * runtime side effects, not cache hits).
 */
function createCountingStore(root: string, calls: StoreCall[]) {
  const readStoreBytes = async (relativePath: string): Promise<Uint8Array | null> => {
    const fullPath = join(root, relativePath);
    try {
      const info = await stat(fullPath);
      if (info.isDirectory()) {
        return null;
      }
      return await readFile(fullPath);
    } catch {
      return null;
    }
  };

  const strip = (path: string) => (path.startsWith('/') ? path.slice(1) : path);

  return {
    async get(path: string) {
      calls.push({ op: 'GET', path: strip(path) });
      return readStoreBytes(strip(path));
    },
    async getRange(
      path: string,
      range: { offset?: number; length?: number; suffixLength?: number }
    ) {
      calls.push({ op: 'RANGE', path: strip(path) });
      const bytes = await readStoreBytes(strip(path));
      if (!bytes) {
        return null;
      }
      if (range.suffixLength != null) {
        return bytes.subarray(bytes.length - range.suffixLength);
      }
      const offset = range.offset ?? 0;
      const length = range.length ?? bytes.length - offset;
      return bytes.subarray(offset, offset + length);
    },
  };
}

/**
 * A points element with NO morton index — the capped-preload path, which is where
 * the refetching was observed.
 */
async function writeNonMortonPointsFixture(root: string) {
  const elementDir = join(root, ELEMENT_PATH);
  await mkdir(join(root, PARQUET_DIR), { recursive: true });
  await writeFile(join(root, 'zarr.json'), JSON.stringify({ zarr_format: 3, node_type: 'group' }));
  await writeFile(
    join(elementDir, 'zarr.json'),
    JSON.stringify({
      attributes: {
        'encoding-type': 'ngff:points',
        axes: ['x', 'y'],
        spatialdata_attrs: { feature_key: 'genes', version: '0.2' },
      },
      zarr_format: 3,
      node_type: 'group',
    })
  );

  execSync(
    `uv run python - <<'PY'
import pyarrow as pa
import pyarrow.parquet as pq
from pathlib import Path

root = Path(${JSON.stringify(join(root, PARQUET_DIR))})
rows = ${ROWS}
table = pa.table(
    {
        "x": [float(i % 100) for i in range(rows)],
        "y": [float((i * 7) % 100) for i in range(rows)],
        "genes": pa.array([f"gene_{i % 5}" for i in range(rows)]).dictionary_encode(),
    }
)
pq.write_table(table, root / "part.0.parquet", row_group_size=500)
PY`,
    { cwd: writerRoot, stdio: 'pipe' }
  );
}

/**
 * Loading ONE non-morton points layer used to pull the same `part.N.parquet` down
 * once per independent step — 15 whole-file GETs of a 13 MB part in the reported
 * case. The steps run concurrently, and the byte cache held the settled value, so
 * every one of them missed it.
 */
describe('one non-morton points load fetches each parquet part once', () => {
  let fixtureRoot: string;
  let source: SpatialDataPointsSource;
  const calls: StoreCall[] = [];

  beforeAll(async () => {
    fixtureRoot = await mkdtemp(join(tmpdir(), 'points-fetch-count-'));
    await writeNonMortonPointsFixture(fixtureRoot);
    source = new SpatialDataPointsSource({
      // biome-ignore lint/suspicious/noExplicitAny: minimal zarr.Readable test double
      store: createCountingStore(fixtureRoot, calls) as any,
      fileType: '.zarr',
    });
  }, 120_000);

  afterAll(async () => {
    await rm(fixtureRoot, { recursive: true, force: true });
  });

  it('pulls the part down once across the concurrent steps of a load', async () => {
    calls.length = 0;

    // Exactly the four independent things PointsResolver asks for when an element
    // becomes visible, started together as the resolver starts them.
    const [preload] = await Promise.all([
      source.loadPoints(ELEMENT_PATH, { includeFeatureCodes: true, memoryCap: 1_000_000 }),
      source.listPointsFeaturesWithCounts(ELEMENT_PATH),
      source.loadPointsRowFeatureCodes(ELEMENT_PATH, { memoryCap: 1_000_000 }),
      source.getPointsTilingMetadata(ELEMENT_PATH),
    ]);

    expect(preload.shape[1]).toBe(ROWS);

    const wholeFileGets = calls.filter((call) => call.op === 'GET' && call.path === PART_0);
    expect(wholeFileGets).toHaveLength(1);

    // The element's `.zattrs` walk is shared too — it used to run once per step.
    const attrsReads = calls.filter((call) => call.path === `${ELEMENT_PATH}/.zattrs`);
    expect(attrsReads).toHaveLength(1);

    // A bound on the whole load, so a newly added step that refetches shows up
    // here even if it is not one of the paths named above.
    expect(calls.length).toBeLessThanOrEqual(12);
  }, 120_000);

  it('serves a repeat load entirely from cache', async () => {
    // Prime, then measure: nothing should reach the store a second time.
    await source.loadPoints(ELEMENT_PATH, { includeFeatureCodes: true, memoryCap: 1_000_000 });
    calls.length = 0;
    await source.loadPoints(ELEMENT_PATH, { includeFeatureCodes: true, memoryCap: 1_000_000 });

    expect(calls.filter((call) => call.op === 'GET' && call.path === PART_0)).toHaveLength(0);
  }, 120_000);
});

/**
 * The reported >22,000-request case: a server that resolves ANY path under
 * `points.parquet/` onto the real part file, so `part.0`, `part.1`, … all answer
 * with valid parquet bytes and the enumeration never terminates. Such a server is
 * also the one that answers `HEAD` on the `points.parquet` DIRECTORY with 200.
 */
describe('part enumeration is bounded when every part.N path answers', () => {
  function createEchoingStore(partBytes: Uint8Array, calls: StoreCall[]) {
    return {
      async get(path: string) {
        calls.push({ op: 'GET', path });
        // Anything under the directory — but not the directory itself, which such a
        // server answers with an HTML listing that fails the parquet magic check.
        return path.includes('/part.') ? partBytes : null;
      },
    };
  }

  it('throws instead of looping forever', async () => {
    const parquetBytes = new Uint8Array([
      0x50, 0x41, 0x52, 0x31, 0x00, 0x00, 0x00, 0x00, 0x50, 0x41, 0x52, 0x31,
    ]);
    const calls: StoreCall[] = [];
    const source = new SpatialDataTableSource({
      // biome-ignore lint/suspicious/noExplicitAny: minimal zarr.Readable test double
      store: createEchoingStore(parquetBytes, calls) as any,
      fileType: '.zarr',
    });
    // No `readMetadata`/`getRange`, so the layout question falls to the whole-file
    // probe — the expensive walk of the two.
    // biome-ignore lint/suspicious/noExplicitAny: test double for the WASM module surface
    SpatialDataTableSource.parquetModulePromise = Promise.resolve({} as any);

    await expect(source.loadParquetTable(PARQUET_DIR)).rejects.toThrow(
      /exceeded 512 parts|Failed to load parquet/
    );
    expect(calls.length).toBeLessThanOrEqual(MAX_PARQUET_PARTS + 4);
  });
});
