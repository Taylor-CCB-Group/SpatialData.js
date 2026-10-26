import { execSync } from 'node:child_process';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Matrix4 } from '@math.gl/core';
import { FileSystemStore } from '@zarrita/storage';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PointsResolver } from '../src/engine/index.js';
import type { PointsElement } from '../src/models/index.js';
import { createPointsLoaderForElement } from '../src/pointsLoader.js';
import type { SpatialBounds } from '../src/pointsTiling.js';
import { POINTS_ZARR_SIDECAR } from '../src/pointsZarr.js';
import { readZarr } from '../src/store/index.js';

/**
 * The points-zarr reader against a store written by `spatialdata-js-util points zarr`
 * (the format's reference validator, in merfisheyes' `scripts/points_zarr.py`, accepts
 * that writer's output). The answers are computed from the input points, not from the
 * store. Reads are observed at the store, so "reads only what the view needs" is a
 * claim about requests, not about caches.
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
const writerRoot = join(__dirname, '../../../python/spatialdata-js-util');

interface Expected {
  genes: string[];
  counts: number[];
  levels: number[];
  extent: SpatialBounds;
  beta_xyz_sorted: [number, number, number][];
  alpha_bbox: [number, number, number, number];
  alpha_in_bbox: number;
}

/**
 * 3,000 points, 4 genes of very different abundance, 3 levels; chunks of 128 rows in
 * shards of 4, so reads cross both.
 */
function writeFixture(dir: string) {
  const input = join(dir, 'points.parquet');
  execSync(
    `uv run python - <<'PY'
import json
import numpy as np
import pandas as pd

rng = np.random.default_rng(7)
n = 3000
genes = ["Alpha", "Beta", "Gamma", "Delta"]
x = rng.uniform(0, 1000, n).astype(np.float32)
y = rng.uniform(0, 600, n).astype(np.float32)
z = rng.uniform(-5, 5, n).astype(np.float32)
f = rng.choice(4, n, p=[0.6, 0.25, 0.1, 0.05])
pd.DataFrame(
    {"x": x, "y": y, "z": z, "gene": pd.Categorical.from_codes(f, categories=genes)}
).to_parquet(${JSON.stringify(input)})

bbox = [250, 100, 520, 330]
inside = (f == 0) & (x >= bbox[0]) & (x < bbox[2]) & (y >= bbox[1]) & (y < bbox[3])
beta = sorted(
    [round(float(a), 3), round(float(b), 3), round(float(c), 3)]
    for a, b, c in zip(x[f == 1], y[f == 1], z[f == 1])
)
expected = {
    "genes": genes,
    "counts": [int((f == i).sum()) for i in range(4)],
    "extent": {
        "minX": float(x.min()), "minY": float(y.min()),
        "maxX": float(x.max()), "maxY": float(y.max()),
    },
    "beta_xyz_sorted": beta,
    "alpha_bbox": bbox,
    "alpha_in_bbox": int(inside.sum()),
}
with open(${JSON.stringify(join(dir, 'expected.json'))}, "w") as fh:
    json.dump(expected, fh)
PY`,
    { cwd: writerRoot, stdio: 'pipe' }
  );
  const summary = execSync(
    `uv run spatialdata-js-util points zarr ${JSON.stringify(input)} ${JSON.stringify(join(dir, 'store.zarr'))} --feature-key gene --coordinates x,y,z --levels 3 --chunk-rows 128 --shard-chunks 4`,
    { cwd: writerRoot, stdio: ['ignore', 'pipe', 'pipe'] }
  ).toString();
  // The same points in merfisheyes' own layout, where the element itself is the
  // points-zarr group: stores written by their tools still have to open.
  execSync(
    `uv run python - <<'PY'
import pandas as pd
import zarr
from spatialdata_js_util import write_points_zarr

store = ${JSON.stringify(join(dir, 'store.zarr'))}
write_points_zarr(
    pd.read_parquet(${JSON.stringify(input)}),
    store + "/points/theirs",
    feature_key="gene",
    coordinates=("x", "y", "z"),
    n_levels=3,
)
zarr.consolidate_metadata(store)
PY`,
    { cwd: writerRoot, stdio: 'pipe' }
  );
  return JSON.parse(summary).levels as number[];
}

let fixtureDir: string;
let expected: Expected;

beforeAll(async () => {
  fixtureDir = await mkdtemp(join(tmpdir(), 'points-zarr-'));
  const levels = writeFixture(fixtureDir);
  expected = { ...JSON.parse(await readFile(join(fixtureDir, 'expected.json'), 'utf8')), levels };
}, 120_000);

afterAll(async () => {
  await rm(fixtureDir, { recursive: true, force: true });
});

type AbsolutePath = `/${string}`;
type RangeQuery = { offset: number; length: number } | { suffixLength: number };

/** A filesystem store that records the key of every read and the bytes it returned. */
class CountingStore {
  readonly reads: { key: string; range?: string; bytes: number }[] = [];
  private readonly inner: FileSystemStore;

  constructor(root: string) {
    this.inner = new FileSystemStore(root);
  }

  /** Called before each read; a test uses it to cancel at a chosen moment. */
  beforeRead?: (key: string) => void;

  /** Honours the read's signal, as a fetch-backed or browser file store does. */
  private start(key: string, opts?: { signal?: AbortSignal }) {
    this.beforeRead?.(key);
    opts?.signal?.throwIfAborted();
  }

  async get(key: AbsolutePath, opts?: { signal?: AbortSignal }) {
    this.start(key, opts);
    const bytes = await this.inner.get(key);
    this.reads.push({ key, bytes: bytes?.byteLength ?? 0 });
    return bytes;
  }

  async getRange(key: AbsolutePath, range: RangeQuery, opts?: { signal?: AbortSignal }) {
    this.start(key, opts);
    const bytes = await this.inner.getRange(key, range);
    this.reads.push({ key, range: JSON.stringify(range), bytes: bytes?.byteLength ?? 0 });
    return bytes;
  }

  /**
   * Reads of per-point data — coordinate chunks and feature-code chunks — and not of
   * the index, the metadata, or an enum's names.
   */
  pointColumnReads() {
    return this.reads.filter((r) =>
      /\/(tile|feature)_major\/column_\d+\/(codes\/)?c\//.test(r.key)
    );
  }

  reset() {
    this.reads.length = 0;
  }
}

let store: CountingStore;
let element: PointsElement;

beforeEach(async () => {
  store = new CountingStore(join(fixtureDir, 'store.zarr'));
  const sdata = await readZarr(store);
  const points = sdata.points?.transcripts;
  if (!points) throw new Error('fixture has no points/transcripts');
  element = points;
  store.reset();
});

// Wider than the data on every side; `expected.extent` is the data's own extent.
const wholeExtent = { minX: 0, minY: 0, maxX: 1000, maxY: 600 };
const UNLIMITED = Number.POSITIVE_INFINITY;

describe('points-zarr element', () => {
  it('finds the copy beside the standard element and reports tileable metadata', async () => {
    expect(element.storage).toBe('parquet');
    expect(element.pointsZarrPath).toBe(`points/transcripts/${POINTS_ZARR_SIDECAR}`);
    const metadata = await element.getPointsTilingMetadata();
    expect(metadata).toMatchObject({
      kind: 'points-zarr',
      version: '0.1',
      featureKey: 'gene',
      totalRows: expected.levels[0],
      levelCount: expected.levels.length,
      bounds: expected.extent,
    });
    expect(store.pointColumnReads()).toEqual([]);
  });

  it('lists features with exact counts without reading any points', async () => {
    const catalog = await element.listFeaturesWithCounts();
    expect(catalog?.entries).toEqual(
      expected.genes.map((name, code) => ({ code, name, count: expected.counts[code] }))
    );
    expect(store.pointColumnReads()).toEqual([]);
  });

  it('returns exactly one feature inside a region at full resolution', async () => {
    const [minX, minY, maxX, maxY] = expected.alpha_bbox;
    const result = await element.loadPointsZarrInBounds({
      bounds: { minX, minY, maxX, maxY },
      featureCodes: [0],
      pointBudget: UNLIMITED,
    });
    expect(result.levels).toEqual([0]);
    expect(result.pointCount).toBe(expected.alpha_in_bbox);
    expect(new Set(result.featureCodes)).toEqual(new Set([0]));
    const [xs, ys] = result.data;
    for (let i = 0; i < result.pointCount; i++) {
      expect(xs[i]).toBeGreaterThanOrEqual(minX);
      expect(xs[i]).toBeLessThan(maxX);
      expect(ys[i]).toBeGreaterThanOrEqual(minY);
      expect(ys[i]).toBeLessThan(maxY);
    }
  });

  it('holds no memory for the rows it filtered out', async () => {
    // A tile keeps its batch in deck's cache for as long as it is cached, so a view
    // onto a buffer sized to every row read would pin the rows the filter dropped.
    const [minX, minY, maxX, maxY] = expected.alpha_bbox;
    const result = await element.loadPointsZarrInBounds({
      bounds: { minX, minY, maxX, maxY },
      featureCodes: [0],
      pointBudget: UNLIMITED,
    });
    expect(result.rowsRead).toBeGreaterThan(result.pointCount);
    for (const column of [...result.data, result.featureCodes]) {
      expect(column.buffer.byteLength).toBe(result.pointCount * column.BYTES_PER_ELEMENT);
    }
  });

  it('returns every point of a feature across the extent, with z', async () => {
    const result = await element.loadPointsZarrInBounds({
      bounds: wholeExtent,
      featureCodes: [1],
      pointBudget: UNLIMITED,
    });
    const [xs, ys, zs] = result.data;
    const round = (v: number) => Math.round(v * 1000) / 1000;
    const got = Array.from({ length: result.pointCount }, (_, i) => [
      round(xs[i]),
      round(ys[i]),
      round(zs[i]),
    ]).sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]);
    expect(got).toEqual(expected.beta_xyz_sorted);
  });

  it('reads all features from tile_major, carrying each point its code', async () => {
    const result = await element.loadPointsZarrInBounds({
      bounds: wholeExtent,
      pointBudget: UNLIMITED,
    });
    expect(result.levels).toEqual([0]);
    expect(result.pointCount).toBe(expected.levels[0]);
    const tally = new Array(expected.genes.length).fill(0);
    for (const code of result.featureCodes) tally[code]++;
    expect(tally).toEqual(expected.counts);
    expect(store.pointColumnReads().every((r) => r.key.includes('/tile_major/'))).toBe(true);
  });

  it('fetches no byte range twice within one read', async () => {
    // Beta lies in every tile row, so a per-row read would revisit shared chunks.
    await element.loadPointsZarrInBounds({
      bounds: wholeExtent,
      featureCodes: [1],
      pointBudget: UNLIMITED,
    });
    const reads = store.pointColumnReads().map((r) => `${r.key} ${r.range ?? 'whole'}`);
    expect(reads.length).toBeGreaterThan(0);
    expect(new Set(reads).size).toBe(reads.length);
  });

  it("includes the points on the far edge of the element's extent", async () => {
    // Tiles are half-open so a shared edge is drawn once, but the extent's own max is
    // a point's coordinate: a tile ending there must keep it.
    const result = await element.loadPointsZarrInBounds({
      bounds: expected.extent,
      pointBudget: UNLIMITED,
    });
    expect(result.pointCount).toBe(expected.levels[0]);
  });

  it('draws nothing for an empty selection', async () => {
    const result = await element.loadPointsZarrInBounds({
      bounds: wholeExtent,
      featureCodes: [],
      pointBudget: UNLIMITED,
    });
    expect(result.pointCount).toBe(0);
    expect(store.pointColumnReads()).toEqual([]);
  });

  it('falls back to a coarser level, and reads fewer bytes, when the budget is small', async () => {
    const full = await element.loadPointsZarrInBounds({
      bounds: wholeExtent,
      featureCodes: [0],
      pointBudget: UNLIMITED,
    });
    const fullBytes = store.pointColumnReads().reduce((sum, r) => sum + r.bytes, 0);
    store.reset();

    const sampled = await element.loadPointsZarrInBounds({
      bounds: wholeExtent,
      featureCodes: [0],
      pointBudget: 200,
    });
    const sampledBytes = store.pointColumnReads().reduce((sum, r) => sum + r.bytes, 0);

    expect(sampled.levels[0]).toBeGreaterThan(0);
    expect(sampled.pointCount).toBeLessThan(full.pointCount);
    expect(sampledBytes).toBeLessThan(fullBytes);
  });

  it('keeps a rare feature whole while sampling an abundant one under one budget', async () => {
    // Delta (135 points) fits any fair share of 400; Alpha (1,775) cannot.
    const result = await element.loadPointsZarrInBounds({
      bounds: wholeExtent,
      featureCodes: [0, 3],
      pointBudget: 400,
    });
    const [alphaLevel, deltaLevel] = result.levels;
    expect(deltaLevel).toBe(0);
    expect(alphaLevel).toBeGreaterThan(0);
    const delta = Array.from(result.featureCodes).filter((code) => code === 3).length;
    expect(delta).toBe(expected.counts[3]);
  });

  it('chooses the level from the unclipped tile, so a clipped edge tile matches its neighbours', async () => {
    const tile = { minX: 0, minY: 0, maxX: 400, maxY: 400 };
    const clipped = { minX: 0, minY: 0, maxX: 400, maxY: 40 };
    const budget = 300;
    const whole = await element.loadPointsZarrInBounds({
      bounds: tile,
      featureCodes: [0],
      pointBudget: budget,
    });
    const edge = await element.loadPointsZarrInBounds({
      bounds: clipped,
      levelBounds: tile,
      featureCodes: [0],
      pointBudget: budget,
    });
    const edgeAlone = await element.loadPointsZarrInBounds({
      bounds: clipped,
      featureCodes: [0],
      pointBudget: budget,
    });
    expect(edge.levels).toEqual(whole.levels);
    expect(edgeAlone.levels[0]).toBeLessThan(whole.levels[0]);
  });

  it('rejects with an AbortError when the read is cancelled', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      element.loadPointsZarrInBounds({
        bounds: wholeExtent,
        featureCodes: [0],
        pointBudget: UNLIMITED,
        signal: controller.signal,
      })
    ).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('settles every read it started when a tile is cancelled', async () => {
    // A cancelled tile's reads all reject; any left unawaited surfaces as an unhandled
    // rejection, one per read, every time a pan or zoom prunes tiles.
    const unhandled: unknown[] = [];
    const record = (reason: unknown) => unhandled.push(reason);
    process.on('unhandledRejection', record);
    const controller = new AbortController();
    store.beforeRead = (key) => {
      if (/tile_major\/column_0\/c\//.test(key)) controller.abort();
    };
    try {
      await expect(
        element.loadPointsZarrInBounds({
          bounds: wholeExtent,
          pointBudget: UNLIMITED,
          signal: controller.signal,
        })
      ).rejects.toMatchObject({ name: 'AbortError' });
      await new Promise((resolve) => setTimeout(resolve, 50));
    } finally {
      process.off('unhandledRejection', record);
      store.beforeRead = undefined;
    }
    expect(unhandled).toEqual([]);
  });

  it('retries a read that failed, rather than keeping the failure', async () => {
    let failed = false;
    store.beforeRead = (key) => {
      if (!failed && key.endsWith('/index/tile_rows/c/0')) {
        failed = true;
        throw new Error('transient read error');
      }
    };
    const read = () =>
      element.loadPointsZarrInBounds({ bounds: wholeExtent, pointBudget: UNLIMITED });
    await expect(read()).rejects.toThrow('transient read error');
    expect((await read()).pointCount).toBe(expected.levels[0]);
    store.beforeRead = undefined;
  });

  it('falls back to the standard copy when the points-zarr copy cannot be read', async () => {
    // A copy in a version this reader does not know, beside a readable parquet.
    const dir = await mkdtemp(join(tmpdir(), 'points-zarr-unknown-'));
    try {
      const copy = join(dir, 'store.zarr');
      await cp(join(fixtureDir, 'store.zarr'), copy, { recursive: true });
      const rootPath = join(copy, 'zarr.json');
      const root = JSON.parse(await readFile(rootPath, 'utf8'));
      root.consolidated_metadata.metadata[`points/transcripts/${POINTS_ZARR_SIDECAR}`].attributes[
        'points:version'
      ] = '9.9';
      await writeFile(rootPath, JSON.stringify(root));
      const sdata = await readZarr(new FileSystemStore(copy));
      const points = sdata.points?.transcripts;
      if (!points) throw new Error('copy has no points/transcripts');
      const catalog = await points.listFeaturesWithCounts();
      expect(catalog?.entries.map((e) => e.name).sort()).toEqual([...expected.genes].sort());
      // Not tileable from the copy, and the plain parquet is not Morton-sorted.
      expect(await points.getPointsTilingMetadata()).toBeNull();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('still reads the standard copy beside it', async () => {
    expect(await element.getParquetRowCount()).toBe(expected.levels[0]);
  });

  it("opens merfisheyes' own layout, where the element is the points-zarr group", async () => {
    const sdata = await readZarr(new FileSystemStore(join(fixtureDir, 'store.zarr')));
    const theirs = sdata.points?.theirs;
    if (!theirs) throw new Error('fixture has no points/theirs');
    expect(theirs.storage).toBe('points-zarr');
    expect(theirs.pointsZarrPath).toBe('points/theirs');
    const result = await theirs.loadPointsZarrInBounds({
      bounds: expected.extent,
      pointBudget: UNLIMITED,
    });
    expect(result.pointCount).toBe(expected.levels[0]);
    // It has no standard copy to preload from.
    await expect(theirs.loadPoints()).rejects.toThrow(/points-zarr element/);
  });

  it('builds a tiled loader whose batches carry feature codes', async () => {
    const metadata = await element.getPointsTilingMetadata();
    const loader = createPointsLoaderForElement(element, {
      tilingMetadata: metadata,
      wantsOptimized: true,
    });
    expect(loader?.capabilities.kind).toBe('points-zarr-tiled');
    const batch = await loader?.loadInBounds({ bounds: wholeExtent, featureCodes: [2] });
    expect(batch?.pointCount).toBeGreaterThan(0);
    expect(batch?.featureCodes && new Set(batch.featureCodes)).toEqual(new Set([2]));
    expect(batch?.shape).toEqual([3, batch?.pointCount]);
  });
});

describe('points-zarr through the resolver', () => {
  it('goes straight to tiles: probe, then catalog, and never a parquet preload', async () => {
    const resolver = new PointsResolver();
    const context = {
      entryId: 'layer-p',
      elementKey: 'transcripts',
      kind: 'points' as const,
      element,
      config: {},
      transform: new Matrix4(),
    };
    const signal = new AbortController().signal;
    const resources = () => resolver.plan(context).map((task) => task.resource);

    expect(resources()).toEqual(['tiling']);
    for (const task of resolver.plan(context)) await resolver.load(task, context, signal);
    expect(resources()).toEqual(['catalog']);
    for (const task of resolver.plan(context)) await resolver.load(task, context, signal);
    expect(resources()).toEqual([]);

    const snapshot = resolver.snapshot(context);
    expect(snapshot.resources.preload).toBeUndefined();
    expect(snapshot.bounds).not.toBeNull();
    expect(resolver.getFeatureCatalog('transcripts')?.entries.map((e) => e.count)).toEqual(
      expected.counts
    );
    expect(store.pointColumnReads()).toEqual([]);
  });
});
