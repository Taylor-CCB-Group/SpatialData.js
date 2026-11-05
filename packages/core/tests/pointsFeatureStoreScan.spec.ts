import { execSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { storeBackedParquetBlob } from '../src/parquetStoreBlob.js';
import { ExposedPointsSource } from './exposedPointsSource.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const writerRoot = join(__dirname, '../../../python/spatialdata-js-util');

const ROWS = 20_000;
const GENES = ['gene_a', 'gene_b', 'gene_c', 'gene_d'];

/**
 * A dictionary-only feature column (which row-group decode returns as empty
 * names) next to wide columns the scan has no use for, in many row groups.
 * A Xenium `transcripts` element has the same shape.
 */
async function writeFixture(root: string) {
  const parquetPath = join(root, 'points', 'transcripts', 'points.parquet');
  await mkdir(dirname(parquetPath), { recursive: true });
  execSync(
    `uv run python - <<'PY'
import numpy as np
import pyarrow as pa
import pyarrow.parquet as pq

rows = ${ROWS}
genes = ${JSON.stringify(GENES)}
rng = np.random.default_rng(0)
table = pa.table(
    {
        "x": rng.random(rows),
        "y": rng.random(rows),
        "z": rng.random(rows),
        "transcript_id": rng.integers(0, 2**62, rows, dtype=np.int64),
        "feature_name": pa.array([genes[i % len(genes)] for i in range(rows)]).dictionary_encode(),
    }
)
pq.write_table(table, ${JSON.stringify(parquetPath)}, row_group_size=1000)
PY`,
    { cwd: writerRoot, stdio: 'pipe' }
  );
  return parquetPath;
}

/**
 * A store that answers only ranged reads and has no `url`, like a zarrextra
 * `ZipStore` or `FolderStore`. Records every byte it hands out.
 */
function rangeOnlyStore(files: Map<string, Uint8Array>) {
  const bytesRead = { total: 0 };
  return {
    bytesRead,
    store: {
      async get(_path: string): Promise<Uint8Array | undefined> {
        throw new Error('whole-file read through a range-capable store');
      },
      async getRange(
        path: string,
        range: { offset: number; length: number } | { suffixLength: number }
      ): Promise<Uint8Array | undefined> {
        const bytes = files.get(path);
        if (!bytes) {
          return undefined;
        }
        const slice =
          'suffixLength' in range
            ? bytes.subarray(bytes.length - range.suffixLength)
            : bytes.subarray(range.offset, range.offset + range.length);
        bytesRead.total += slice.byteLength;
        return slice;
      },
    },
  };
}

describe('points feature catalog on a store without a url', () => {
  let fixtureRoot: string;
  let fileBytes: Uint8Array;

  beforeAll(async () => {
    fixtureRoot = await mkdtemp(join(tmpdir(), 'points-store-scan-'));
    fileBytes = await readFile(await writeFixture(fixtureRoot));
  }, 120_000);

  afterAll(async () => {
    await rm(fixtureRoot, { recursive: true, force: true });
  });

  it('streams only the feature column through the store', async () => {
    const { store, bytesRead } = rangeOnlyStore(
      new Map([['/points/transcripts/points.parquet', fileBytes]])
    );
    const source = new ExposedPointsSource({ store, fileType: '.zarr' });
    vi.spyOn(source, 'loadSpatialDataElementAttrs').mockResolvedValue({
      'encoding-type': 'ngff:points',
      axes: ['x', 'y'],
      spatialdata_attrs: { feature_key: 'feature_name', version: '0.2' },
    });
    // Over the preload cap, so the oversized-dataset scan runs.
    vi.spyOn(source, 'resolveParquetRowCount').mockResolvedValue(5_000_000);
    const wholeFile = vi.spyOn(source, 'loadParquetTable');

    const catalog = await source.listPointsFeatures('points/transcripts');

    expect(catalog?.entries).toEqual(
      GENES.map((name, code) => ({ code, name, count: ROWS / GENES.length }))
    );
    expect(wholeFile).not.toHaveBeenCalled();
    // The geometry and id columns are most of the file; none of them is read.
    expect(bytesRead.total).toBeLessThan(fileBytes.byteLength / 4);
  }, 60_000);

  it('declines a part that would not fit under the blob it claims to be', () => {
    const read = vi.fn();
    expect(storeBackedParquetBlob(read, new Uint8Array(16), 100, 64)).toBeNull();
    expect(storeBackedParquetBlob(read, new Uint8Array(16), 48, 64)).not.toBeNull();
  });

  it('serves the tail from the footer and the rest from the store', async () => {
    const footer = Uint8Array.from([9, 9, 9, 9]);
    const read = vi.fn(async (offset: number, length: number) =>
      Uint8Array.from({ length }, (_v, i) => offset + i)
    );
    const blob = storeBackedParquetBlob(read, footer, 4, 16);
    const straddling = new Uint8Array(await blob!.slice(10, 16).arrayBuffer());
    expect(Array.from(straddling)).toEqual([10, 11, 9, 9, 9, 9]);
    expect(read).toHaveBeenCalledWith(10, 2);
  });

  it('throws on a short store read rather than hand the reader zeros', async () => {
    const blob = storeBackedParquetBlob(async () => new Uint8Array(1), new Uint8Array(4), 4, 16);
    await expect(blob!.slice(0, 4).arrayBuffer()).rejects.toThrow(/returned 1 bytes/);
  });
});
