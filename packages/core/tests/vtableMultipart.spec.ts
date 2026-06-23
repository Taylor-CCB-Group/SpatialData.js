import { execSync } from 'node:child_process';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import SpatialDataTableSource from '../src/models/VTableSource.js';

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

function createFilesystemStore(root: string) {
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

  return {
    async get(path: string) {
      const relativePath = path.startsWith('/') ? path.slice(1) : path;
      return readStoreBytes(relativePath);
    },
    async getRange(path: string, range: { offset?: number; length?: number; suffixLength?: number }) {
      const relativePath = path.startsWith('/') ? path.slice(1) : path;
      const bytes = await readStoreBytes(relativePath);
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

describe('SpatialDataTableSource multipart parquet reads', () => {
  let fixtureRoot: string;
  let source: SpatialDataTableSource;
  const parquetPath = 'points/transcripts/points.parquet';

  beforeAll(async () => {
    fixtureRoot = await mkdtemp(join(tmpdir(), 'multipart-parquet-'));
    await writeMultipartParquetFixture(join(fixtureRoot, parquetPath), [100, 50]);
    source = new SpatialDataTableSource({
      store: createFilesystemStore(fixtureRoot),
      fileType: '.zarr',
    });
  }, 120_000);

  afterAll(async () => {
    await rm(fixtureRoot, { recursive: true, force: true });
  });

  it('concatenates all multipart parquet files for full-table reads', async () => {
    const table = await source.loadParquetTable(parquetPath);
    expect(table.numRows).toBe(150);
  });

  it('loads feature columns across all parts for catalog-style reads', async () => {
    const table = await source.loadParquetTable(parquetPath, [
      'feature_name',
      'feature_name_codes',
    ]);
    expect(table.numRows).toBe(150);
    const codes = table.getChild('feature_name_codes')?.toArray();
    expect(codes?.length).toBe(150);
  });

  it('loads capped column subset via row-group range reads', async () => {
    const { table, truncated, totalRows } = await source.loadParquetTableCapped(
      parquetPath,
      ['x', 'y'],
      120,
      { useRowGroupReads: true }
    );
    expect(totalRows).toBe(150);
    expect(truncated).toBe(true);
    expect(table.numRows).toBe(120);
    expect(table.getChild('x')?.length).toBe(120);
    expect(table.getChild('y')?.length).toBe(120);
  });
});
