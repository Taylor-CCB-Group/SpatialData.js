import { execSync } from 'node:child_process';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import SpatialDataTableSource from '../src/models/VTableSource.js';

/**
 * A store whose `getRange` is a lie: it accepts the range and returns the WHOLE
 * file, which is what a static server that never implemented HTTP Range does (it
 * answers 200, not 206, and zarrita's store reads a 200 body happily).
 *
 * This shape is more dangerous than an outright refusal. A whole parquet file
 * satisfies the footer probe's magic check — its last four bytes really are
 * `PAR1` — so the loader used to read the footer length from the file's FIRST four
 * bytes, which are `PAR1` too: ~1.2e9. The follow-up read could never satisfy
 * that, the layout never resolved, and because nothing recorded the failure the
 * element re-requested the layout forever (tens of thousands of requests, still
 * climbing after ten seconds).
 *
 * Fetch counts, not cache internals: the guarantee is about what reaches the
 * network, so that is what these assert.
 */
const __dirname = dirname(fileURLToPath(import.meta.url));
const writerRoot = join(__dirname, '../../../python/spatialdata-js-util');

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
 * `ignoresRange: false` gives the same store with WORKING ranges, so each
 * assertion below can be read against the behaviour it is meant to approximate.
 */
function createStore(root: string, { ignoresRange }: { ignoresRange: boolean }) {
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
      // A static server answers a directory with an HTML listing, 200. Any bytes
      // that fail the parquet magic check stand in for it — and crucially they are
      // also "longer than the range asked for", which must NOT be mistaken for a
      // server that ignores Range.
      return new TextEncoder().encode('<!DOCTYPE html><html><body>Index of …</body></html>');
    }
    try {
      return await readFile(join(root, relativePath));
    } catch {
      return null; // missing file → 404 → null (this is how part enumeration stops)
    }
  };

  const strip = (path: string) => (path.startsWith('/') ? path.slice(1) : path);

  return {
    reads,
    countReadsOf: (path: string) => reads.filter((read) => read === path).length,
    async get(path: string) {
      return readStoreBytes(strip(path));
    },
    async getRange(
      path: string,
      range: { offset?: number; length?: number; suffixLength?: number }
    ) {
      const bytes = await readStoreBytes(strip(path));
      if (!bytes) {
        return null;
      }
      if (ignoresRange) {
        return bytes; // the whole body, whatever was asked for
      }
      if (range.suffixLength != null) {
        return bytes.subarray(Math.max(0, bytes.length - range.suffixLength));
      }
      const offset = range.offset ?? 0;
      const length = range.length ?? bytes.length - offset;
      return bytes.subarray(offset, offset + length);
    },
  };
}

describe('SpatialDataTableSource — server ignores HTTP Range', () => {
  let fixtureRoot: string;
  const parquetPath = 'points/transcripts/points.parquet';

  beforeAll(async () => {
    fixtureRoot = await mkdtemp(join(tmpdir(), 'range-ignored-parquet-'));
    await writeMultipartParquetFixture(join(fixtureRoot, parquetPath), [100, 50]);
  }, 120_000);

  afterAll(async () => {
    await rm(fixtureRoot, { recursive: true, force: true });
  });

  it('still reads the whole table, and settles in a bounded number of reads', async () => {
    const store = createStore(fixtureRoot, { ignoresRange: true });
    const source = new SpatialDataTableSource({ store, fileType: '.zarr' });

    // The contract is "succeeds or fails, but BOUNDS the requests". It succeeds:
    // whole-file reads are the fallback this class already supports, and once the
    // range reader is known to be a lie that is the path taken.
    const table = await source.loadParquetTable(parquetPath);
    expect(table.numRows).toBe(150);

    const readsAfterLoad = store.reads.length;
    // Generous, but orders of magnitude below the unbounded loop: the point is that
    // a number exists at all.
    expect(readsAfterLoad).toBeLessThan(40);

    // Repeating every call site a points load makes must not re-walk the paths.
    for (let i = 0; i < 10; i += 1) {
      await source.loadParquetDatasetMetadata(parquetPath);
      await source.loadParquetTable(parquetPath);
    }
    expect(store.reads.length).toBeLessThan(readsAfterLoad + 10);
  }, 120_000);

  it('never parses a footer length out of a whole-file response', async () => {
    const store = createStore(fixtureRoot, { ignoresRange: true });
    const source = new SpatialDataTableSource({ store, fileType: '.zarr' });

    // The garbage footer length was ~1.2e9, which the follow-up read reported as a
    // length mismatch rather than a throw — so the visible symptom was an endless
    // retry, not an error. Returning null here is what stops the whole cascade.
    const schemaBytes = await source.loadParquetSchemaBytes(parquetPath);
    expect(schemaBytes).toBeNull();
  }, 120_000);

  it('demotes the source to whole-file reads rather than probing ranges forever', async () => {
    const store = createStore(fixtureRoot, { ignoresRange: true });
    const source = new SpatialDataTableSource({ store, fileType: '.zarr' });

    await source.loadParquetTable(parquetPath);
    const readsBefore = store.reads.length;

    // A range-backed layout is not merely slow on such a server, it is impossible:
    // it must answer null instead of re-probing on every caller.
    expect(await source.loadParquetDatasetMetadata(parquetPath)).toBeNull();
    expect(await source.loadParquetDatasetMetadata(parquetPath)).toBeNull();
    expect(store.reads.length).toBe(readsBefore);
  }, 120_000);

  it('does not mistake an HTML directory listing for a broken Range server', async () => {
    // The directory path is probed FIRST on every load, and its listing is always
    // longer than the eight bytes the footer probe asks for. Reading that as "this
    // server ignores Range" would demote every healthy server to whole-file reads.
    const store = createStore(fixtureRoot, { ignoresRange: false });
    const source = new SpatialDataTableSource({ store, fileType: '.zarr' });

    const dataset = await source.loadParquetDatasetMetadata(parquetPath);
    expect(dataset?.parts.map((part) => part.path)).toEqual([
      `${parquetPath}/part.0.parquet`,
      `${parquetPath}/part.1.parquet`,
    ]);
    expect(dataset?.totalNumRows).toBe(150);
  }, 120_000);
});
