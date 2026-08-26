import { describe, expect, it } from 'vitest';
import { PointsStreamAccumulator } from '../src/pointsStreamAccumulator.js';
import type { ParquetWorkerStreamChunk } from '../src/workers/parquetWorkerProtocol.js';

/**
 * The main-thread half of the worker's streaming preload.
 *
 * The worker sends DELTAS — a batch's own rows, the features it was first to see,
 * its own tallies — so everything the caller finally hands the renderer is built
 * here. These pin the three things that silently corrupt a preload if they drift:
 * the append offset, the running catalog, and the per-feature counts.
 */

const BASE = {
  axisCount: 2,
  featureKey: 'feature_name',
  totalRowCount: 500,
  preloadTruncated: false,
  hasFeatureCodeColumn: false,
};

/** One batch: explicit xs/ys and codes, plus whatever catalog entries are new. */
function chunk(options: {
  partIndex?: number;
  partCount?: number;
  xs: number[];
  ys: number[];
  codes: number[];
  newFeatures?: Array<{ code: number; name: string }>;
}): ParquetWorkerStreamChunk {
  const tally = new Map<number, number>();
  for (const code of options.codes) {
    tally.set(code, (tally.get(code) ?? 0) + 1);
  }
  return {
    kind: 'geometryWithFeaturesBatch',
    partIndex: options.partIndex ?? 0,
    partCount: options.partCount ?? 1,
    rows: options.codes.length,
    axes: [Float32Array.from(options.xs), Float32Array.from(options.ys)],
    featureCodes: Int32Array.from(options.codes),
    newFeatures: options.newFeatures ?? [],
    tallyCodes: Int32Array.from([...tally.keys()]),
    tallyCounts: Uint32Array.from([...tally.values()]),
  };
}

describe('PointsStreamAccumulator', () => {
  it('appends consecutive batches at the cursor, not over each other', () => {
    const accumulator = new PointsStreamAccumulator({ ...BASE, maxRows: 10 });
    accumulator.append(
      chunk({
        xs: [1, 2, 3],
        ys: [10, 20, 30],
        codes: [0, 0, 1],
        newFeatures: [
          { code: 0, name: 'ABCC11' },
          { code: 1, name: 'ACE2' },
        ],
      })
    );
    accumulator.append(chunk({ xs: [4, 5], ys: [40, 50], codes: [1, 0] }));

    expect(accumulator.filled).toBe(5);
    const snapshot = accumulator.snapshot();
    expect(snapshot.shape).toEqual([2, 5]);
    expect(Array.from(snapshot.data[0])).toEqual([1, 2, 3, 4, 5]);
    expect(Array.from(snapshot.data[1])).toEqual([10, 20, 30, 40, 50]);
    expect(Array.from(snapshot.featureCodes ?? [])).toEqual([0, 0, 1, 1, 0]);
  });

  it('exposes each partial as views over the filled prefix, never the whole buffer', () => {
    const accumulator = new PointsStreamAccumulator({ ...BASE, maxRows: 1_000 });
    accumulator.append(chunk({ xs: [1, 2], ys: [3, 4], codes: [0, 0] }));
    const snapshot = accumulator.snapshot();
    // Preallocated at 1000 but only 2 rows in: a partial that reported the whole
    // buffer would paint 998 points at the origin.
    expect(snapshot.data[0].length).toBe(2);
    expect(snapshot.featureCodes?.length).toBe(2);
  });

  it('grows the catalog across batches and keeps it describing the codes written', () => {
    const accumulator = new PointsStreamAccumulator({ ...BASE, maxRows: 10 });
    accumulator.append(
      chunk({ xs: [1], ys: [1], codes: [0], newFeatures: [{ code: 0, name: 'ABCC11' }] })
    );
    expect(accumulator.snapshot().featureCatalog?.entries).toEqual([
      { code: 0, name: 'ABCC11' },
    ]);

    accumulator.append(
      chunk({ xs: [2], ys: [2], codes: [1], newFeatures: [{ code: 1, name: 'ACE2' }] })
    );
    const catalog = accumulator.snapshot().featureCatalog;
    expect(catalog?.featureKey).toBe('feature_name');
    expect(catalog?.entries).toEqual([
      { code: 0, name: 'ABCC11' },
      { code: 1, name: 'ACE2' },
    ]);
  });

  it('reuses the catalog object across batches that brought no new features', () => {
    const accumulator = new PointsStreamAccumulator({ ...BASE, maxRows: 10 });
    accumulator.append(
      chunk({ xs: [1], ys: [1], codes: [0], newFeatures: [{ code: 0, name: 'ABCC11' }] })
    );
    const first = accumulator.snapshot().featureCatalog;
    accumulator.append(chunk({ xs: [2], ys: [2], codes: [0] }));
    // Identity, not equality: rebuilding a 12k-entry catalog on each of ~60 ticks
    // is exactly the main-thread cost this path exists to remove.
    expect(accumulator.snapshot().featureCatalog).toBe(first);
  });

  it('accumulates per-feature tallies across batches', () => {
    const accumulator = new PointsStreamAccumulator({ ...BASE, maxRows: 10 });
    accumulator.append(
      chunk({
        xs: [1, 2, 3],
        ys: [1, 2, 3],
        codes: [0, 1, 0],
        newFeatures: [
          { code: 0, name: 'ABCC11' },
          { code: 1, name: 'ACE2' },
        ],
      })
    );
    accumulator.append(chunk({ xs: [4, 5], ys: [4, 5], codes: [1, 1] }));
    expect(accumulator.snapshot().featureCodeCounts).toEqual(
      new Map([
        [0, 2],
        [1, 3],
      ])
    );
  });

  it('hands out an independent tally per snapshot', () => {
    const accumulator = new PointsStreamAccumulator({ ...BASE, maxRows: 10 });
    accumulator.append(chunk({ xs: [1], ys: [1], codes: [0] }));
    const early = accumulator.snapshot().featureCodeCounts;
    accumulator.append(chunk({ xs: [2], ys: [2], codes: [0] }));
    // A consumer holding an earlier tick must not see it mutate underneath.
    expect(early?.get(0)).toBe(1);
    expect(accumulator.snapshot().featureCodeCounts?.get(0)).toBe(2);
  });

  describe('the row cap', () => {
    it('takes only the prefix of a batch that straddles it', () => {
      const accumulator = new PointsStreamAccumulator({ ...BASE, maxRows: 4 });
      accumulator.append(chunk({ xs: [1, 2], ys: [1, 2], codes: [0, 0] }));
      const taken = accumulator.append(
        chunk({ xs: [3, 4, 5, 6], ys: [3, 4, 5, 6], codes: [0, 0, 1, 1] })
      );
      expect(taken).toBe(2);
      expect(accumulator.filled).toBe(4);
      expect(Array.from(accumulator.snapshot().data[0])).toEqual([1, 2, 3, 4]);
    });

    it('re-tallies a straddling batch so the counts match the rows kept', () => {
      const accumulator = new PointsStreamAccumulator({ ...BASE, maxRows: 3 });
      accumulator.append(
        chunk({
          xs: [1, 2, 3, 4],
          ys: [1, 2, 3, 4],
          codes: [0, 0, 1, 1],
          newFeatures: [
            { code: 0, name: 'ABCC11' },
            { code: 1, name: 'ACE2' },
          ],
        })
      );
      // The batch's own tally says ACE2 has 2 rows; only one of them fits.
      expect(accumulator.snapshot().featureCodeCounts).toEqual(
        new Map([
          [0, 2],
          [1, 1],
        ])
      );
    });

    it('takes nothing once full, so the caller can skip a pointless tick', () => {
      const accumulator = new PointsStreamAccumulator({ ...BASE, maxRows: 2 });
      accumulator.append(chunk({ xs: [1, 2], ys: [1, 2], codes: [0, 0] }));
      expect(accumulator.append(chunk({ xs: [3], ys: [3], codes: [0] }))).toBe(0);
      expect(accumulator.filled).toBe(2);
    });
  });

  it('leaves an axis missing from a batch zeroed rather than failing the load', () => {
    const accumulator = new PointsStreamAccumulator({ ...BASE, axisCount: 3, maxRows: 4 });
    const batch = chunk({ xs: [1, 2], ys: [3, 4], codes: [0, 0] });
    accumulator.append(batch); // two axes supplied, the element declares three
    expect(Array.from(accumulator.snapshot().data[2])).toEqual([0, 0]);
  });

  it('carries the preload framing through to every snapshot', () => {
    const accumulator = new PointsStreamAccumulator({
      ...BASE,
      maxRows: 4,
      totalRowCount: 4_831_895,
      preloadTruncated: true,
      hasFeatureCodeColumn: true,
    });
    accumulator.append(chunk({ xs: [1], ys: [1], codes: [0] }));
    const snapshot = accumulator.snapshot();
    // These describe the DATASET, not how far the stream got — a consumer reads
    // them to know the preload is a capped sample of a much larger element.
    expect(snapshot.totalRowCount).toBe(4_831_895);
    expect(snapshot.preloadTruncated).toBe(true);
    expect(snapshot.hasFeatureCodeColumn).toBe(true);
  });

  it('reports an empty preload before any batch lands', () => {
    const accumulator = new PointsStreamAccumulator({ ...BASE, maxRows: 4 });
    expect(accumulator.filled).toBe(0);
    const snapshot = accumulator.snapshot();
    expect(snapshot.shape).toEqual([2, 0]);
    expect(snapshot.featureCatalog?.entries).toEqual([]);
  });
});
