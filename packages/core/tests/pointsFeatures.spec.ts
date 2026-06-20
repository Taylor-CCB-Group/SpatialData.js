import { execSync } from 'node:child_process';
import { mkdtemp, readFile, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import SpatialDataPointsSource from '../src/models/VPointsSource.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const writerRoot = join(__dirname, '../../../python/spatialdata-experimental-writer');

async function writePointsFeatureFixture(root: string) {
  const elementDir = join(root, 'points', 'transcripts');
  await mkdir(elementDir, { recursive: true });

  execSync(
    `uv run python - <<'PY'
import pyarrow as pa
import pyarrow.parquet as pq
from pathlib import Path

root = Path(${JSON.stringify(elementDir)})
(root / "points.parquet").mkdir(parents=True, exist_ok=True)
table0 = pa.table(
    {
        "x": [0.0, 1.0, 2.0],
        "y": [0.0, 1.0, 2.0],
        "feature_name": ["gene_a", "gene_b", "gene_a"],
        "feature_name_codes": pa.array([0, 1, 0], type=pa.int32()),
    }
)
table1 = pa.table(
    {
        "x": [3.0, 4.0],
        "y": [3.0, 4.0],
        "feature_name": ["gene_c", "gene_b"],
        "feature_name_codes": pa.array([2, 1], type=pa.int32()),
    }
)
pq.write_table(table0, root / "points.parquet" / "part.0.parquet")
pq.write_table(table1, root / "points.parquet" / "part.1.parquet")
PY`,
    { cwd: writerRoot, stdio: 'pipe' }
  );
}

function createFilesystemStore(root: string) {
  return {
    async get(path: string) {
      const relativePath = path.startsWith('/') ? path.slice(1) : path;
      try {
        return await readFile(join(root, relativePath));
      } catch {
        return null;
      }
    },
    async getRange(path: string, range: { offset?: number; length?: number; suffixLength?: number }) {
      const relativePath = path.startsWith('/') ? path.slice(1) : path;
      const bytes = await readFile(join(root, relativePath));
      if (range.suffixLength != null) {
        return bytes.subarray(bytes.length - range.suffixLength);
      }
      const offset = range.offset ?? 0;
      const length = range.length ?? bytes.length - offset;
      return bytes.subarray(offset, offset + length);
    },
  };
}

describe('SpatialDataPointsSource feature catalog', () => {
  let fixtureRoot: string;
  let source: SpatialDataPointsSource;

  beforeAll(async () => {
    fixtureRoot = await mkdtemp(join(tmpdir(), 'points-features-'));
    await writePointsFeatureFixture(fixtureRoot);
    source = new SpatialDataPointsSource({
      store: createFilesystemStore(fixtureRoot),
      fileType: '.zarr',
    });
    vi.spyOn(source, 'loadSpatialDataElementAttrs').mockResolvedValue({
      'encoding-type': 'ngff:points',
      axes: ['x', 'y'],
      spatialdata_attrs: {
        feature_key: 'feature_name',
        version: '0.2',
      },
    });
  }, 120_000);

  afterAll(async () => {
    await rm(fixtureRoot, { recursive: true, force: true });
  });

  it('lists distinct feature names and codes across multipart parquet', async () => {
    const catalog = await source.listPointsFeatures('points/transcripts');
    expect(catalog).toEqual({
      featureKey: 'feature_name',
      entries: [
        { code: 0, name: 'gene_a' },
        { code: 1, name: 'gene_b' },
        { code: 2, name: 'gene_c' },
      ],
    });
  });

  it('loads feature code column with full points preload', async () => {
    const points = await source.loadPoints('points/transcripts');
    expect(points.shape[1]).toBe(5);
    expect(points.featureCodes?.length).toBe(5);
  });
});
