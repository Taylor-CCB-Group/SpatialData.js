import { execSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  decodeIntStat,
  ParquetPhysicalType,
  parseParquetFileMetaData,
} from '../src/parquetFooterStats.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const writerRoot = join(__dirname, '../../../python/spatialdata-experimental-writer');

/** Slice the Thrift `FileMetaData` bytes out of a full parquet file. */
function footerMetaData(fileBytes: Uint8Array): Uint8Array {
  const n = fileBytes.length;
  expect(String.fromCharCode(...fileBytes.subarray(n - 4))).toBe('PAR1');
  const len = new DataView(fileBytes.buffer, fileBytes.byteOffset + n - 8, 4).getUint32(0, true);
  return fileBytes.subarray(n - 8 - len, n - 8);
}

describe('parseParquetFileMetaData', () => {
  let root: string;
  let fileBytes: Uint8Array;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'footer-stats-'));
    // 8 rows, feature codes sorted, 2 rows per row group -> 4 row groups with
    // code ranges [0,0], [1,1], [2,2], [3,3].
    execSync(
      `uv run python - <<'PY'
import pyarrow as pa
import pyarrow.parquet as pq
from pathlib import Path
root = Path(${JSON.stringify(root)})
table = pa.table({
    "x": pa.array([0.0,1.0,2.0,3.0,4.0,5.0,6.0,7.0], type=pa.float32()),
    "y": pa.array([0.0,1.0,2.0,3.0,4.0,5.0,6.0,7.0], type=pa.float32()),
    "feature_name": ["A","A","B","B","C","C","D","D"],
    "feature_name_codes": pa.array([0,0,1,1,2,2,3,3], type=pa.int32()),
})
pq.write_table(table, root / "sorted.parquet", row_group_size=2, write_statistics=True)
PY`,
      { cwd: writerRoot, stdio: 'pipe' }
    );
    fileBytes = new Uint8Array(await readFile(join(root, 'sorted.parquet')));
  }, 120_000);

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('recovers row-group count, num_rows, and column paths', () => {
    const meta = parseParquetFileMetaData(footerMetaData(fileBytes));
    expect(meta.numRows).toBe(8);
    expect(meta.rowGroups).toHaveLength(4);
    for (const rg of meta.rowGroups) {
      expect(rg.numRows).toBe(2);
      expect(rg.columns.map((c) => c.path).sort()).toEqual([
        'feature_name',
        'feature_name_codes',
        'x',
        'y',
      ]);
    }
  });

  it('recovers per-row-group feature_name_codes min/max from Statistics', () => {
    const meta = parseParquetFileMetaData(footerMetaData(fileBytes));
    const ranges = meta.rowGroups.map((rg) => {
      const col = rg.columns.find((c) => c.path === 'feature_name_codes');
      expect(col?.physicalType).toBe(ParquetPhysicalType.INT32);
      return [
        decodeIntStat(col?.minValue, col?.physicalType ?? null),
        decodeIntStat(col?.maxValue, col?.physicalType ?? null),
      ];
    });
    // Sorted codes, 2 per group -> contiguous, non-overlapping ranges.
    expect(ranges).toEqual([
      [0, 0],
      [1, 1],
      [2, 2],
      [3, 3],
    ]);
  });

  it('recovers string (feature_name) min/max bytes', () => {
    const meta = parseParquetFileMetaData(footerMetaData(fileBytes));
    const decoder = new TextDecoder();
    const rg2 = meta.rowGroups[2].columns.find((c) => c.path === 'feature_name');
    expect(rg2?.physicalType).toBe(ParquetPhysicalType.BYTE_ARRAY);
    expect(rg2?.minValue && decoder.decode(rg2.minValue)).toBe('C');
    expect(rg2?.maxValue && decoder.decode(rg2.maxValue)).toBe('C');
  });
});
