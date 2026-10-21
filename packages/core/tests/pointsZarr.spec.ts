import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Matrix4 } from '@math.gl/core';
import { FileSystemStore } from '@zarrita/storage';
import { beforeEach, describe, expect, it } from 'vitest';
import { PointsResolver } from '../src/engine/index.js';
import type { PointsElement } from '../src/models/index.js';
import { createPointsLoaderForElement } from '../src/pointsLoader.js';
import { readZarr } from '../src/store/index.js';

/**
 * The points-zarr reader against merfisheyes' own tiny fixture (see
 * `fixtures/points-zarr/README.md`), checked against the answers their generator
 * recorded beside it. Reads are observed at the store, so "reads only what the view
 * needs" is a claim about requests, not about caches.
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixtureRoot = join(__dirname, 'fixtures/points-zarr');
const expected: {
  genes: string[];
  counts: number[];
  levels: number[];
  beta_xyz_sorted: [number, number, number][];
  alpha_bbox: [number, number, number, number];
  alpha_in_bbox: number;
} = JSON.parse(readFileSync(join(fixtureRoot, 'points_expected.json'), 'utf8'));

type AbsolutePath = `/${string}`;
type RangeQuery = { offset: number; length: number } | { suffixLength: number };

/** A filesystem store that records the key of every read and the bytes it returned. */
class CountingStore {
  readonly reads: { key: string; range?: string; bytes: number }[] = [];
  private readonly inner: FileSystemStore;

  constructor(root: string) {
    this.inner = new FileSystemStore(root);
  }

  async get(key: AbsolutePath) {
    const bytes = await this.inner.get(key);
    this.reads.push({ key, bytes: bytes?.byteLength ?? 0 });
    return bytes;
  }

  async getRange(key: AbsolutePath, range: RangeQuery) {
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
  store = new CountingStore(join(fixtureRoot, 'points_v1.zarr'));
  const sdata = await readZarr(store);
  const points = sdata.points?.transcripts;
  if (!points) throw new Error('fixture has no points/transcripts');
  element = points;
  store.reset();
});

const wholeExtent = { minX: 0, minY: 0, maxX: 1000, maxY: 600 };
const UNLIMITED = Number.POSITIVE_INFINITY;

describe('points-zarr element', () => {
  it('is recognised from its attrs and reports tileable metadata', async () => {
    expect(element.storage).toBe('points-zarr');
    const metadata = await element.getPointsTilingMetadata();
    expect(metadata).toMatchObject({
      kind: 'points-zarr',
      version: '0.1',
      featureKey: 'gene',
      totalRows: expected.levels[0],
      levelCount: expected.levels.length,
      bounds: wholeExtent,
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

  it('refuses the parquet-only paths with a message naming the format', async () => {
    await expect(element.loadPoints()).rejects.toThrow(/points-zarr element/);
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
