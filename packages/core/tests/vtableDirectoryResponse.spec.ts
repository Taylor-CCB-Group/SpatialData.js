import { execSync } from 'node:child_process';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import SpatialDataTableSource from '../src/models/VTableSource.js';

/**
 * A points/shapes `*.parquet` path is a DIRECTORY of `part.N.parquet` files as
 * often as it is a single file. Servers disagree on how they answer a range read
 * of a directory, and that disagreement was load-bearing: a static server 404s
 * (which the store maps to `undefined`), so part enumeration ran and the element
 * loaded — but MDV's Flask returns **500** `[Errno 21] Is a directory`, the store
 * throws on any non-2xx that is not 404, and that throw escaped
 * `loadParquetDatasetMetadata` before it ever probed `part.0.parquet`. The element
 * wedged.
 *
 * This pins the resolver against BOTH server behaviours over the same real
 * multipart fixture: the only difference between the two stores is what a read of
 * the directory path does (return null vs. throw), and both must find the parts.
 */
const __dirname = dirname(fileURLToPath(import.meta.url));
const writerRoot = join(__dirname, '../../../python/spatialdata-experimental-writer');

async function writeMultipartParquetFixture(root: string, partRows: [number, number]) {
  execSync(
    `uv run python - <<'PY'
import pyarrow as pa
import pyarrow.parquet as pq
from pathlib import Path

root = Path(${JSON.stringify(root)})
root.mkdir(parents=True, exist_ok=True)

def write_part(path: Path, start: int, count: int) -> None:
    table = pa.table(
        {
            "x": [float(start + i) for i in range(count)],
            "y": [float(i) for i in range(count)],
            "feature_name": [f"gene_{i % 3}" for i in range(count)],
            "feature_name_codes": pa.array([(i % 3) for i in range(count)], type=pa.int32()),
        }
    )
    pq.write_table(table, path)

write_part(root / "part.0.parquet", 0, ${partRows[0]})
write_part(root / "part.1.parquet", ${partRows[0]}, ${partRows[1]})
PY`,
    { cwd: writerRoot, stdio: 'pipe' }
  );
}

/**
 * A store whose read of a directory path THROWS instead of returning null — the
 * MDV/Flask "[Errno 21] Is a directory" 500, as the zarrita store surfaces it (any
 * non-2xx that is not 404 becomes a throw).
 */
function createDirectoryThrowsStore(root: string) {
  /** Every path read, in order — the test's stand-in for the network tab. */
  const reads: string[] = [];
  const isDirectory = async (relativePath: string): Promise<boolean> => {
    try {
      return (await stat(join(root, relativePath))).isDirectory();
    } catch {
      return false;
    }
  };
  const readStoreBytes = async (relativePath: string): Promise<Uint8Array | null> => {
    reads.push(relativePath);
    if (await isDirectory(relativePath)) {
      // The server would 500 here; the store turns that into a throw.
      throw new Error(`Unexpected response status 500 [Errno 21] Is a directory: ${relativePath}`);
    }
    try {
      return await readFile(join(root, relativePath));
    } catch {
      return null; // missing file → 404 → null (this is how part enumeration stops)
    }
  };

  return {
    reads,
    countReadsOf: (path: string) => reads.filter((read) => read === path).length,
    clearReads: () => {
      reads.length = 0;
    },
    async get(path: string) {
      return readStoreBytes(path.startsWith('/') ? path.slice(1) : path);
    },
    async getRange(
      path: string,
      range: { offset?: number; length?: number; suffixLength?: number }
    ) {
      const bytes = await readStoreBytes(path.startsWith('/') ? path.slice(1) : path);
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

describe('SpatialDataTableSource — directory path returns 500 (MDV/Flask)', () => {
  let fixtureRoot: string;
  let source: SpatialDataTableSource;
  let store: ReturnType<typeof createDirectoryThrowsStore>;
  const parquetPath = 'points/transcripts/points.parquet';

  beforeAll(async () => {
    fixtureRoot = await mkdtemp(join(tmpdir(), 'directory-500-parquet-'));
    await writeMultipartParquetFixture(join(fixtureRoot, parquetPath), [100, 50]);
    store = createDirectoryThrowsStore(fixtureRoot);
    source = new SpatialDataTableSource({ store, fileType: '.zarr' });
  }, 120_000);

  afterAll(async () => {
    await rm(fixtureRoot, { recursive: true, force: true });
  });

  it('traverses part.N.parquet instead of throwing when the directory 500s', async () => {
    const metadata = await source.loadParquetDatasetMetadata(parquetPath);
    expect(metadata).not.toBeNull();
    expect(metadata?.parts.map((part) => part.path)).toEqual([
      `${parquetPath}/part.0.parquet`,
      `${parquetPath}/part.1.parquet`,
    ]);
    expect(metadata?.totalNumRows).toBe(150);
  });

  it('reads the full table across parts despite the directory 500', async () => {
    const table = await source.loadParquetTable(parquetPath);
    expect(table.numRows).toBe(150);
  });

  /**
   * The layout of a read-only store never changes, but a single points load asks
   * for it ~20 times (row counts, tiling, row-group extents, the streaming reader,
   * …). Uncached, each of those repeated the whole probe sequence — which is what
   * put a stream of repeated directory 500s and trailing 404s in the network tab.
   */
  describe('remembers the layout', () => {
    const missingPart = `${parquetPath}/part.2.parquet`;

    it('probes the directory and the end-of-sequence 404 exactly once', async () => {
      // A COLD source: the shared one is already warm from the tests above (which
      // is itself the behaviour under test, just not measurable from here).
      const cold = new SpatialDataTableSource({
        store: createDirectoryThrowsStore(fixtureRoot),
        fileType: '.zarr',
      });
      const coldStore = (cold as unknown as { storeRoot: { store: typeof store } }).storeRoot.store;

      const first = await cold.loadParquetDatasetMetadata(parquetPath);
      const probesAfterFirst = coldStore.reads.length;
      expect(probesAfterFirst).toBeGreaterThan(0);
      for (let i = 0; i < 5; i += 1) {
        await cold.loadParquetDatasetMetadata(parquetPath);
      }

      // The 500-ing directory path and the 404 past the last part: once each, ever.
      expect(coldStore.countReadsOf(parquetPath)).toBe(1);
      expect(coldStore.countReadsOf(missingPart)).toBe(1);
      // Five further calls cost NOTHING — not merely fewer reads.
      expect(coldStore.reads.length).toBe(probesAfterFirst);
      expect(first?.parts).toHaveLength(2);
    });

    it('shares one probe between concurrent callers', async () => {
      // The real trigger: many call sites fire at once during a points load, so a
      // cache that only populated on settle would still stampede.
      const fresh = new SpatialDataTableSource({
        store: createDirectoryThrowsStore(fixtureRoot),
        fileType: '.zarr',
      });
      const freshStore = (fresh as unknown as { storeRoot: { store: typeof store } }).storeRoot
        .store;

      const results = await Promise.all(
        Array.from({ length: 6 }, () => fresh.loadParquetDatasetMetadata(parquetPath))
      );

      expect(freshStore.countReadsOf(parquetPath)).toBe(1);
      expect(freshStore.countReadsOf(missingPart)).toBe(1);
      // All callers get the same resolved layout.
      for (const result of results) {
        expect(result?.parts.map((part) => part.path)).toEqual([
          `${parquetPath}/part.0.parquet`,
          `${parquetPath}/part.1.parquet`,
        ]);
      }
    });

    it('does not re-probe parts when reading tables, which uses the other enumerator', async () => {
      // `discoverMultipartPartPaths` derives the same layout by WHOLE-FILE reads
      // (the fallback for stores without range support). It used to enumerate
      // part.0, part.1, … independently — even for elements the metadata had
      // already resolved — which is the second source of repeated 404s.
      const cold = new SpatialDataTableSource({
        store: createDirectoryThrowsStore(fixtureRoot),
        fileType: '.zarr',
      });
      const coldStore = (cold as unknown as { storeRoot: { store: typeof store } }).storeRoot.store;

      await cold.loadParquetTable(parquetPath);
      await cold.loadParquetTable(parquetPath, ['x', 'y']);

      expect(coldStore.countReadsOf(parquetPath)).toBe(1);
      expect(coldStore.countReadsOf(missingPart)).toBe(1);
    });

    it('does not cache a miss, so a transient failure cannot mark a real dataset absent', async () => {
      // `probeParquetPartMetadata` turns a failed probe into null rather than a
      // throw, so an all-probes-failed run is indistinguishable from "no dataset
      // here". Caching that would strand a real element behind one network blip.
      const flaky = new SpatialDataTableSource({
        store: createDirectoryThrowsStore(fixtureRoot),
        fileType: '.zarr',
      });
      const absent = 'points/absent/points.parquet';

      expect(await flaky.loadParquetDatasetMetadata(absent)).toBeNull();
      const readsAfterMiss = (
        flaky as unknown as { storeRoot: { store: typeof store } }
      ).storeRoot.store.reads.filter((read) => read.startsWith('points/absent')).length;
      expect(await flaky.loadParquetDatasetMetadata(absent)).toBeNull();
      const readsAfterSecondMiss = (
        flaky as unknown as { storeRoot: { store: typeof store } }
      ).storeRoot.store.reads.filter((read) => read.startsWith('points/absent')).length;

      expect(readsAfterSecondMiss).toBeGreaterThan(readsAfterMiss);
    });
  });
});
