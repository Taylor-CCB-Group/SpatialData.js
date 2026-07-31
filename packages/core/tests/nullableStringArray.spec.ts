import { execSync } from 'node:child_process';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FileSystemStore } from '@zarrita/storage';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import SpatialDataTableSource from '../src/models/VTableSource.js';
import { readZarr } from '../src/store/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const writerRoot = join(__dirname, '../../../python/spatialdata-js-util');

/**
 * Write a SpatialData store whose table uses AnnData's nullable encodings.
 *
 * These are groups of `values` + `mask`, not arrays. AnnData writes them by
 * default from 0.13 onwards, so this is what a freshly written store looks like
 * — a reader that opens `var/_index` as an array fails on it and has no variable
 * names to show.
 *
 * Note that only the index ends up as `nullable-string-array`: AnnData's
 * `strings_to_categoricals` turns string *columns* into categoricals on write,
 * so the nullable string case is reached through `obs/_index` and `var/_index`.
 * A nullable *integer* column exercises the same group layout with a mask that
 * actually has a bit set.
 */
function writeNullableTableFixture(storeRoot: string) {
  execSync(
    `uv run --extra write python - <<'PY'
import anndata as ad
import numpy as np
import pandas as pd
import scipy.sparse as sp
import spatialdata as sd
from pathlib import Path
from spatialdata.models import TableModel

root = Path(${JSON.stringify(storeRoot)})

adata = ad.AnnData(X=sp.random(10, 6, density=0.5, format="csc", random_state=0, dtype=np.float32))
adata.var.index = pd.array([f"GENE{i}" for i in range(6)], dtype="string")
adata.obs.index = pd.array([f"cell{i}" for i in range(10)], dtype="string")
adata.obs["region"] = pd.Categorical(["img"] * 10)
adata.obs["instance_id"] = np.arange(10)
# Nullable obs columns, so the kind lookup is exercised on columns and not only
# on the index (which \`getObsColumnNames\` filters out).
adata.obs["qc_count"] = pd.array([1, None, 3, 4, 5, 6, 7, 8, 9, 10], dtype="Int64")
adata.obs["passes_qc"] = pd.array(
    [True, None, False, True, True, False, True, True, False, True], dtype="boolean"
)
# A genuine missing value, so the mask is exercised rather than only the
# all-present case.
adata.var["measured"] = pd.array([1, 2, None, 4, 5, 6], dtype="Int64")
# A categorical with a missing entry. Written as a zarr v3 \`string\` categories
# array, which is the case a v2-only dtype check silently mis-reads as codes.
adata.var["family"] = pd.Categorical(["kinase", "kinase", None, "gpcr", "gpcr", "kinase"])

table = TableModel.parse(
    adata, region="img", region_key="region", instance_key="instance_id"
)

ad.settings.zarr_write_format = 3
ad.settings.auto_shard_zarr_v3 = False
ad.settings.allow_write_nullable_strings = True
sd.SpatialData(tables={"table": table}).write(root, overwrite=True)

# Fail loudly here rather than letting the test assert against the wrong layout.
json = __import__("json")


def encoding_of(*parts):
    path = root.joinpath("tables", "table", *parts, "zarr.json")
    return json.loads(path.read_text())["attributes"]["encoding-type"]


for parts, expected in [
    (("var", "_index"), "nullable-string-array"),
    (("obs", "qc_count"), "nullable-integer"),
    (("obs", "passes_qc"), "nullable-boolean"),
]:
    actual = encoding_of(*parts)
    assert actual == expected, f"fixture wrote {actual!r} for {'/'.join(parts)}"
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

describe('nullable-encoded AnnData columns', () => {
  let fixtureRoot: string;
  let storeRoot: string;
  let source: SpatialDataTableSource;

  beforeAll(async () => {
    fixtureRoot = await mkdtemp(join(tmpdir(), 'nullable-anndata-'));
    storeRoot = join(fixtureRoot, 'store.zarr');
    writeNullableTableFixture(storeRoot);
    source = new SpatialDataTableSource({
      store: createFilesystemStore(storeRoot),
      fileType: '.zarr',
    });
  }, 300_000);

  afterAll(async () => {
    await rm(fixtureRoot, { recursive: true, force: true });
  });

  it('reads var names from a nullable-string-array index', async () => {
    const names = await source.loadVarIndex('tables/table');
    expect(names).toEqual(['GENE0', 'GENE1', 'GENE2', 'GENE3', 'GENE4', 'GENE5']);
  });

  it('reads a nullable-string-array obs index', async () => {
    const [ids] = await source.loadObsColumns(['tables/table/obs/_index']);
    expect(Array.from(ids ?? [])).toEqual([
      'cell0',
      'cell1',
      'cell2',
      'cell3',
      'cell4',
      'cell5',
      'cell6',
      'cell7',
      'cell8',
      'cell9',
    ]);
  });

  it('still prefers instance_key over the obs index when the table declares one', async () => {
    // Not a nullable-encoding concern, but it shares the code path — the new
    // branch must not divert reads that were already resolving correctly.
    const ids = await source.loadObsIndex('tables/table');
    expect(ids).toEqual(['0', '1', '2', '3', '4', '5', '6', '7', '8', '9']);
  });

  it('decodes a zarr v3 categorical to labels rather than raw codes', async () => {
    const [family] = await source.loadVarColumns(['tables/table/var/family']);
    expect(Array.from(family ?? [])).toEqual(['kinase', 'kinase', null, 'gpcr', 'gpcr', 'kinase']);
  });

  it('reads a nullable integer column, preserving the missing entry as null', async () => {
    const [measured] = await source.loadVarColumns(['tables/table/var/measured']);
    // Masked entries must stay distinguishable from a real zero.
    expect(Array.from(measured ?? [], (v) => (v === null ? null : Number(v)))).toEqual([
      1,
      2,
      null,
      4,
      5,
      6,
    ]);
  });

  describe('declared column kinds', () => {
    /**
     * The kind lookup runs on the consolidated metadata rather than on decoded
     * values, so it is only meaningful against a tree opened from a real store —
     * a mock tree would assert the shape we chose to write in the mock.
     */
    async function openTable() {
      const sdata = await readZarr(new FileSystemStore(storeRoot));
      const table = sdata.tables?.table;
      if (!table) {
        throw new Error('fixture store has no `table`');
      }
      return table;
    }

    it('reports the kind of a nullable column instead of leaving it undefined', async () => {
      const table = await openTable();
      const kinds = Object.fromEntries(
        ['qc_count', 'passes_qc', 'region', 'instance_id'].map((name) => [
          name,
          table.getObsColumnKinds([name])[0],
        ])
      );
      // The nullable pair is the point: they are groups, so there is no array
      // metadata to fall back on and an unlisted encoding yields `undefined`,
      // which sends callers back to sniffing decoded values.
      expect(kinds).toEqual({
        qc_count: 'numeric',
        passes_qc: 'boolean',
        region: 'categorical',
        instance_id: 'numeric',
      });
    });

    it('still excludes the index from the obs columns when it is nullable-encoded', async () => {
      const table = await openTable();
      expect(table.getObsColumnNames()).not.toContain('_index');
      expect(table.getObsColumnNames()).toEqual(
        expect.arrayContaining(['region', 'instance_id', 'qc_count', 'passes_qc'])
      );
    });
  });
});
