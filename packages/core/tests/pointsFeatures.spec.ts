import { execSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import SpatialDataPointsSource from '../src/models/VPointsSource.js';
import * as pointsWorkerClient from '../src/workers/pointsWorkerClient.js';

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
    async getRange(
      path: string,
      range: { offset?: number; length?: number; suffixLength?: number }
    ) {
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
    // Under the preload cap → whole-table read, which tallies as it decodes:
    // gene_a x2, gene_b x2, gene_c x1 across the two parts.
    const catalog = await source.listPointsFeatures('points/transcripts');
    expect(catalog).toEqual({
      featureKey: 'feature_name',
      entries: [
        { code: 0, name: 'gene_a', count: 2 },
        { code: 1, name: 'gene_b', count: 2 },
        { code: 2, name: 'gene_c', count: 1 },
      ],
    });
  });

  it('lists features for oversized datasets via feature-column scan', async () => {
    vi.spyOn(source, 'resolveParquetRowCount' as keyof SpatialDataPointsSource).mockResolvedValue(
      5_000_000
    );
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

  it('lists features for oversized dictionary-encoded datasets via row-group dictionary read', async () => {
    const elementDir = join(fixtureRoot, 'points', 'dict_large');
    await mkdir(elementDir, { recursive: true });
    execSync(
      `uv run python - <<'PY'
import pyarrow as pa
import pyarrow.parquet as pq
from pathlib import Path

root = Path(${JSON.stringify(elementDir)})
(root / "points.parquet").mkdir(parents=True, exist_ok=True)
genes = pa.array(["gene_a", "gene_b", "gene_c"], type=pa.dictionary(pa.int32(), pa.string()))
names = (["gene_a", "gene_b", "gene_c"] * 34)[:100]
table = pa.table(
    {
        "x": [float(i) for i in range(100)],
        "y": [float(i) for i in range(100)],
        "feature_name": pa.array(names, type=pa.dictionary(pa.int32(), pa.string())),
    }
)
pq.write_table(table, root / "points.parquet" / "part.0.parquet")
PY`,
      { cwd: writerRoot, stdio: 'pipe' }
    );

    const dictSource = new SpatialDataPointsSource({
      store: createFilesystemStore(fixtureRoot),
      fileType: '.zarr',
    });
    vi.spyOn(dictSource, 'loadSpatialDataElementAttrs').mockResolvedValue({
      'encoding-type': 'ngff:points',
      axes: ['x', 'y'],
      spatialdata_attrs: {
        feature_key: 'feature_name',
        version: '0.2',
      },
    });
    vi.spyOn(
      dictSource,
      'resolveParquetRowCount' as keyof SpatialDataPointsSource
    ).mockResolvedValue(5_000_000);

    // Oversized → the byte-oriented feature-column scan, which does not tally
    // (only the streaming scan and the whole-table read do).
    const catalog = await dictSource.listPointsFeatures('points/dict_large');
    expect(catalog?.entries).toEqual([
      { code: 0, name: 'gene_a' },
      { code: 1, name: 'gene_b' },
      { code: 2, name: 'gene_c' },
    ]);
  });

  it('loads feature code column with full points preload via loadPointsRowFeatureCodes', async () => {
    const points = await source.loadPoints('points/transcripts');
    expect(points.shape[1]).toBe(5);
    expect(points.featureCodes).toBeUndefined();
    const featureCodes = await source.loadPointsRowFeatureCodes('points/transcripts');
    expect(featureCodes?.length).toBe(5);
  });

  it('includeFeatureCodes: derives row codes + catalog from the geometry preload', async () => {
    const points = await source.loadPoints('points/transcripts', { includeFeatureCodes: true });
    // geometry is still x/y for the 5 resident rows
    expect(points.shape).toEqual([2, 5]);
    // row-aligned codes and the catalog come from the one decode, no extra load
    expect(points.featureCodes && Array.from(points.featureCodes)).toEqual([0, 1, 0, 2, 1]);
    expect(points.featureCatalog).toEqual({
      featureKey: 'feature_name',
      entries: [
        { code: 0, name: 'gene_a' },
        { code: 1, name: 'gene_b' },
        { code: 2, name: 'gene_c' },
      ],
    });
  });

  it('uses explicit feature code columns instead of dictionary indices', async () => {
    const elementDir = join(fixtureRoot, 'points', 'dict_with_codes');
    await mkdir(elementDir, { recursive: true });
    execSync(
      `uv run python - <<'PY'
import pyarrow as pa
import pyarrow.parquet as pq
from pathlib import Path

root = Path(${JSON.stringify(elementDir)})
(root / "points.parquet").mkdir(parents=True, exist_ok=True)
names = pa.DictionaryArray.from_arrays(
    pa.array([0, 1, 0], type=pa.int32()),
    pa.array(["ABCC11", "TP53"]),
)
table = pa.table(
    {
        "x": [0.0, 1.0, 2.0],
        "y": [0.0, 1.0, 2.0],
        "feature_name": names,
        "feature_name_codes": pa.array([1, 0, 1], type=pa.int32()),
    }
)
pq.write_table(table, root / "points.parquet" / "part.0.parquet")
PY`,
      { cwd: writerRoot, stdio: 'pipe' }
    );

    const dictSource = new SpatialDataPointsSource({
      store: createFilesystemStore(fixtureRoot),
      fileType: '.zarr',
    });
    vi.spyOn(dictSource, 'loadSpatialDataElementAttrs').mockResolvedValue({
      'encoding-type': 'ngff:points',
      axes: ['x', 'y'],
      spatialdata_attrs: {
        feature_key: 'feature_name',
        version: '0.2',
      },
    });

    const catalog = await dictSource.listPointsFeatures('points/dict_with_codes');
    expect(catalog?.entries).toEqual([
      { code: 0, name: 'TP53', count: 1 },
      { code: 1, name: 'ABCC11', count: 2 },
    ]);

    const featureCodes = await dictSource.loadPointsRowFeatureCodes('points/dict_with_codes');
    expect([...featureCodes!]).toEqual([1, 0, 1]);
  });

  it('counts dictionary-only feature columns from the catalog build, not loadFeatureCounts', async () => {
    const elementDir = join(fixtureRoot, 'points', 'dict_counts_untrusted');
    await mkdir(elementDir, { recursive: true });
    execSync(
      `uv run python - <<'PY'
import pyarrow as pa
import pyarrow.parquet as pq
from pathlib import Path

root = Path(${JSON.stringify(elementDir)})
(root / "points.parquet").mkdir(parents=True, exist_ok=True)
names = ["ABCC11", "TP53", "TP53", "EGFR"]
table = pa.table(
    {
        "x": [0.0, 1.0, 2.0, 3.0],
        "y": [0.0, 1.0, 2.0, 3.0],
        "feature_name": pa.array(names, type=pa.dictionary(pa.int32(), pa.string())),
    }
)
pq.write_table(table, root / "points.parquet" / "part.0.parquet")
PY`,
      { cwd: writerRoot, stdio: 'pipe' }
    );

    const dictSource = new SpatialDataPointsSource({
      store: createFilesystemStore(fixtureRoot),
      fileType: '.zarr',
    });
    vi.spyOn(dictSource, 'loadSpatialDataElementAttrs').mockResolvedValue({
      'encoding-type': 'ngff:points',
      axes: ['x', 'y'],
      spatialdata_attrs: {
        feature_key: 'feature_name',
        version: '0.2',
      },
    });

    // `loadFeatureCounts` still declines: it derives codes independently of the
    // catalog, and for a dictionary-only element those codes are app-assigned, so
    // its counts could be keyed to a DIFFERENT code space than the catalog they
    // would be merged into. That guard stays.
    const counts = await dictSource.loadFeatureCounts('points/dict_counts_untrusted');
    expect(counts.size).toBe(0);

    // The catalog build counts as it decodes instead, keyed by the very map it
    // assigns codes from, so the counts cannot disagree with the entries they sit
    // on. Rows are ABCC11, TP53, TP53, EGFR.
    const catalog = await dictSource.listPointsFeaturesWithCounts('points/dict_counts_untrusted');
    expect(catalog?.entries).toEqual([
      { code: 0, name: 'ABCC11', count: 1 },
      { code: 1, name: 'TP53', count: 2 },
      { code: 2, name: 'EGFR', count: 1 },
    ]);
  });

  it('derives row feature codes from dictionary-encoded feature names', async () => {
    const elementDir = join(fixtureRoot, 'points', 'dict_only');
    await mkdir(elementDir, { recursive: true });
    execSync(
      `uv run python - <<'PY'
import pyarrow as pa
import pyarrow.parquet as pq
from pathlib import Path

root = Path(${JSON.stringify(elementDir)})
(root / "points.parquet").mkdir(parents=True, exist_ok=True)
genes = pa.array(["gene_a", "gene_b", "gene_a"], type=pa.dictionary(pa.int32(), pa.string()))
table = pa.table({"x": [0.0, 1.0, 2.0], "y": [0.0, 1.0, 2.0], "feature_name": genes})
pq.write_table(table, root / "points.parquet" / "part.0.parquet")
PY`,
      { cwd: writerRoot, stdio: 'pipe' }
    );

    const dictSource = new SpatialDataPointsSource({
      store: createFilesystemStore(fixtureRoot),
      fileType: '.zarr',
    });
    vi.spyOn(dictSource, 'loadSpatialDataElementAttrs').mockResolvedValue({
      'encoding-type': 'ngff:points',
      axes: ['x', 'y'],
      spatialdata_attrs: {
        feature_key: 'feature_name',
        version: '0.2',
      },
    });

    const points = await dictSource.loadPoints('points/dict_only');
    expect(points.featureCodes).toBeUndefined();
    const featureCodes = await dictSource.loadPointsRowFeatureCodes('points/dict_only');
    expect(featureCodes?.length).toBe(3);
    expect([...featureCodes!]).toEqual([0, 1, 0]);
  });

  it('derives dictionary-only row codes from decoded names, not local dictionary indices', async () => {
    const elementDir = join(fixtureRoot, 'points', 'dict_local_indices');
    await mkdir(elementDir, { recursive: true });
    execSync(
      `uv run python - <<'PY'
import pyarrow as pa
import pyarrow.parquet as pq
from pathlib import Path

root = Path(${JSON.stringify(elementDir)})
(root / "points.parquet").mkdir(parents=True, exist_ok=True)
part0_names = pa.DictionaryArray.from_arrays(
    pa.array([0, 0, 1], type=pa.int32()),
    pa.array(["ABCC11", "TP53"]),
)
part1_names = pa.DictionaryArray.from_arrays(
    pa.array([0, 0, 1], type=pa.int32()),
    pa.array(["TP53", "EGFR"]),
)
part0 = pa.table(
    {
        "x": [0.0, 1.0, 2.0],
        "y": [0.0, 1.0, 2.0],
        "feature_name": part0_names,
    }
)
part1 = pa.table(
    {
        "x": [3.0, 4.0, 5.0],
        "y": [3.0, 4.0, 5.0],
        "feature_name": part1_names,
    }
)
pq.write_table(part0, root / "points.parquet" / "part.0.parquet")
pq.write_table(part1, root / "points.parquet" / "part.1.parquet")
PY`,
      { cwd: writerRoot, stdio: 'pipe' }
    );

    const dictSource = new SpatialDataPointsSource({
      store: createFilesystemStore(fixtureRoot),
      fileType: '.zarr',
    });
    vi.spyOn(dictSource, 'loadSpatialDataElementAttrs').mockResolvedValue({
      'encoding-type': 'ngff:points',
      axes: ['x', 'y'],
      spatialdata_attrs: {
        feature_key: 'feature_name',
        version: '0.2',
      },
    });

    // Counts follow the row codes below: ABCC11 x2, TP53 x3, EGFR x1.
    const catalog = await dictSource.listPointsFeatures('points/dict_local_indices');
    expect(catalog?.entries).toEqual([
      { code: 0, name: 'ABCC11', count: 2 },
      { code: 1, name: 'TP53', count: 3 },
      { code: 2, name: 'EGFR', count: 1 },
    ]);

    const featureCodes = await dictSource.loadPointsRowFeatureCodes('points/dict_local_indices');
    expect([...featureCodes!]).toEqual([0, 0, 1, 1, 1, 2]);
  });

  it('delegates row feature code decode to the points worker when enabled', async () => {
    const workerCodes = Int32Array.from([0, 1, 0, 1, 2]);
    vi.spyOn(pointsWorkerClient, 'ensurePointsWorker').mockImplementation(() => {});
    vi.spyOn(pointsWorkerClient, 'isPointsWorkerEnabled').mockReturnValue(true);
    const decodeSpy = vi
      .spyOn(pointsWorkerClient, 'decodeParquetRowFeatureCodesInWorker')
      .mockResolvedValue(workerCodes);
    vi.spyOn(source, 'canLoadParquetRowGroups').mockResolvedValue(false);

    const featureCodes = await source.loadPointsRowFeatureCodes('points/transcripts');
    expect(decodeSpy).toHaveBeenCalled();
    expect([...featureCodes!]).toEqual([...workerCodes]);
  });

  it('delegates oversized feature catalog scan to the points worker when enabled', async () => {
    const workerCatalog = {
      featureKey: 'feature_name',
      entries: [
        { code: 0, name: 'gene_a' },
        { code: 1, name: 'gene_b' },
      ],
    };
    vi.spyOn(pointsWorkerClient, 'ensurePointsWorker').mockImplementation(() => {});
    vi.spyOn(pointsWorkerClient, 'isPointsWorkerEnabled').mockReturnValue(true);
    const catalogSpy = vi
      .spyOn(pointsWorkerClient, 'scanParquetFeatureCatalogInWorker')
      .mockResolvedValue(workerCatalog);
    vi.spyOn(source, 'resolveParquetRowCount' as keyof SpatialDataPointsSource).mockResolvedValue(
      5_000_000
    );

    const catalog = await source.listPointsFeatures('points/transcripts');
    expect(catalogSpy).toHaveBeenCalled();
    expect(catalog).toEqual(workerCatalog);
  });
});
