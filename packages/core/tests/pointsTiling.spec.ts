import type { Table as ArrowTable } from 'apache-arrow';
import { describe, expect, it } from 'vitest';
import {
  extractSentinelBoundingBox,
  filterColumnarByFeatureCodes,
  filterPointsToBounds,
  MORTON_ZCOVER_MAX_DEPTH,
  mergeAdjacentIntervals,
  mortonBoundsAgreeWithCodes,
  mortonCode2dForPoint,
  mortonIntervalsForBounds,
  mortonRowGroupExtentsAreSorted,
  mortonRowGroupOrderVerdict,
  zcoverRectangle,
} from '../src/pointsTiling.js';

function vector(values: unknown[]) {
  return {
    length: values.length,
    get: (index: number) => values[index],
  };
}

function table(columns: Record<string, unknown[]>): ArrowTable {
  const first = Object.values(columns)[0] ?? [];
  return {
    numRows: first.length,
    getChild: (name: string) => {
      const values = columns[name];
      return values ? vector(values) : null;
    },
  } as unknown as ArrowTable;
}

describe('points tiling helpers', () => {
  it('extracts the Vitessce sentinel bounding box from the leading rows', () => {
    const arrowTable = table({
      x: [10, 20, 15, 17, 99],
      y: [5, 8, 40, 12, 99],
      morton_code_2d: [0, 0, 0, 0, 123],
    });

    expect(extractSentinelBoundingBox(arrowTable)).toEqual({
      minX: 10,
      minY: 5,
      maxX: 20,
      maxY: 40,
    });
  });

  it('accepts bigint morton sentinel values', () => {
    const arrowTable = table({
      x: [10, 20, 15, 17],
      y: [5, 8, 40, 12],
      morton_code_2d: [0n, 0n, 0n, 0n],
    });

    expect(extractSentinelBoundingBox(arrowTable)).toEqual({
      minX: 10,
      minY: 5,
      maxX: 20,
      maxY: 40,
    });
  });

  it('rejects missing or incomplete sentinel bounds', () => {
    expect(
      extractSentinelBoundingBox(
        table({
          x: [10, 20],
          y: [5, 8],
          morton_code_2d: [7, 8],
        })
      )
    ).toBeNull();
  });

  it('merges adjacent Morton intervals', () => {
    expect(
      mergeAdjacentIntervals([
        [10, 12],
        [13, 15],
        [20, 21],
      ])
    ).toEqual([
      [10, 15],
      [20, 21],
    ]);
  });

  it('covers a full rectangle with the full Morton range', () => {
    expect(zcoverRectangle(0, 0, 65535, 65535)).toEqual([[0, 4294967295]]);
  });

  it('produces intervals for a query rectangle inside a stored bbox', () => {
    const intervals = mortonIntervalsForBounds(
      { minX: 0, minY: 0, maxX: 100, maxY: 100 },
      { minX: 10, minY: 10, maxX: 20, maxY: 20 }
    );
    expect(intervals.length).toBeGreaterThan(0);
    expect(intervals.every(([lo, hi]) => lo <= hi)).toBe(true);
  });

  it('filters columnar points to bounds without changing source arrays', () => {
    const xs = new Float32Array([0, 5, 10]);
    const ys = new Float32Array([0, 5, 20]);
    const filtered = filterPointsToBounds(
      { data: [xs, ys], shape: [2, 3] },
      { minX: 1, minY: 1, maxX: 10, maxY: 10 }
    );
    expect(Array.from(filtered.data[0])).toEqual([5]);
    expect(Array.from(filtered.data[1])).toEqual([5]);
    expect(filtered.shape).toEqual([2, 1]);
  });

  it('filters columnar points by feature codes after spatial bounds', () => {
    const xs = new Float32Array([5, 5, 5]);
    const ys = new Float32Array([5, 5, 5]);
    const featureCodes = new Int32Array([0, 1, 2]);
    const filtered = filterPointsToBounds(
      { data: [xs, ys], shape: [2, 3] },
      { minX: 0, minY: 0, maxX: 10, maxY: 10 },
      undefined,
      [1],
      featureCodes
    );
    expect(Array.from(filtered.data[0])).toEqual([5]);
    expect(filtered.shape).toEqual([2, 1]);
  });

  it('filters columnar points by feature codes without bounds', () => {
    const xs = new Float32Array([0, 1, 2]);
    const ys = new Float32Array([0, 1, 2]);
    const sourceFeatureCodes = new Int32Array([0, 1, 0]);
    const filtered = filterColumnarByFeatureCodes(
      { data: [xs, ys], shape: [2, 3] },
      [0],
      sourceFeatureCodes
    );
    expect(Array.from(filtered.data[0])).toEqual([0, 2]);
    expect(filtered.shape).toEqual([2, 2]);
    // Codes for the kept rows come back aligned with the filtered geometry.
    expect(Array.from(filtered.featureCodes ?? [])).toEqual([0, 0]);
  });

  it('returns no rows when feature filter is an empty selection', () => {
    const xs = new Float32Array([0, 1, 2]);
    const ys = new Float32Array([0, 1, 2]);
    const sourceFeatureCodes = new Int32Array([0, 1, 0]);
    const filtered = filterColumnarByFeatureCodes(
      { data: [xs, ys], shape: [2, 3] },
      [],
      sourceFeatureCodes
    );
    expect(filtered.data[0].length).toBe(0);
    expect(filtered.shape).toEqual([2, 0]);
    expect(filtered.featureCodes?.length).toBe(0);
  });

  it('surfaces aligned per-row codes when no filter is applied', () => {
    const xs = new Float32Array([0, 1, 2]);
    const ys = new Float32Array([0, 1, 2]);
    const sourceFeatureCodes = new Int32Array([7, 3, 7]);
    // `featureCodes: undefined` = "all features"; geometry is untouched but the
    // aligned codes are surfaced so the render path can colour by feature.
    const filtered = filterColumnarByFeatureCodes(
      { data: [xs, ys], shape: [2, 3] },
      undefined,
      sourceFeatureCodes
    );
    expect(filtered.data[0]).toBe(xs);
    expect(filtered.featureCodes).toBe(sourceFeatureCodes);
  });
});

/**
 * The cover picks ROW GROUPS, so resolving a rectangle down to individual quantised
 * cells is pure cost. Full-depth recursion produced 38,014 intervals for one
 * viewport-sized rectangle on a real 12.1M-point artifact — 76k row-group bisects to
 * select the same 92 row groups a few hundred intervals select.
 */
describe('zcoverRectangle depth cap', () => {
  /** Interleave two 16-bit coords into a Morton code, as the writer does. */
  const morton = (x: number, y: number): number => {
    let code = 0;
    for (let bit = 0; bit < 16; bit += 1) {
      code += ((x >> bit) & 1) * 2 ** (2 * bit) + ((y >> bit) & 1) * 2 ** (2 * bit + 1);
    }
    return code;
  };

  const covers = (intervals: Array<[number, number]>, code: number) =>
    intervals.some(([lo, hi]) => lo <= code && code <= hi);

  it('collapses the interval count by orders of magnitude', () => {
    const rect: [number, number, number, number] = [12345, 6789, 41000, 20000];

    const full = zcoverRectangle(...rect, 16, 16);
    const capped = zcoverRectangle(...rect);

    expect(full.length).toBeGreaterThan(10_000);
    expect(capped.length).toBeLessThan(full.length / 20);
  });

  it('still covers every code inside the rectangle', () => {
    // Completeness is the property that matters: a dropped code is a hole in the
    // render. Coarser cells may cover MORE than the rectangle, which the exact
    // bounds filter removes after the read.
    const [x0, y0, x1, y1] = [1000, 2000, 3400, 2600];
    const intervals = zcoverRectangle(x0, y0, x1, y1);

    for (let x = x0; x <= x1; x += 37) {
      for (let y = y0; y <= y1; y += 41) {
        expect(covers(intervals, morton(x, y))).toBe(true);
      }
    }
  });

  it('never covers less than the exact cover', () => {
    const rect: [number, number, number, number] = [700, 900, 5000, 3300];
    const full = zcoverRectangle(...rect, 16, 16);
    const capped = zcoverRectangle(...rect);

    // Every code the full-depth cover claims must still be claimed.
    for (const [lo, hi] of full) {
      expect(covers(capped, lo)).toBe(true);
      expect(covers(capped, hi)).toBe(true);
    }
  });

  it('is unchanged for a rectangle that resolves above the cap', () => {
    // A whole-space query is one cell at level 0 — the cap cannot affect it.
    expect(zcoverRectangle(0, 0, 65535, 65535)).toEqual([[0, 4294967295]]);
  });

  it('honours an explicit depth, and clamps it to the coordinate bits', () => {
    const rect: [number, number, number, number] = [10, 20, 5000, 6000];

    expect(zcoverRectangle(...rect, 16, 4).length).toBeLessThan(
      zcoverRectangle(...rect, 16, 8).length
    );
    // Beyond `bits` there is nothing left to subdivide.
    expect(zcoverRectangle(...rect, 16, 99)).toEqual(zcoverRectangle(...rect, 16, 16));
    expect(MORTON_ZCOVER_MAX_DEPTH).toBeLessThan(16);
  });

  it('applies the cap through mortonIntervalsForBounds', () => {
    const bounds = { minX: 0, minY: 0, maxX: 1000, maxY: 1000 };
    const intervals = mortonIntervalsForBounds(bounds, {
      minX: 137,
      minY: 241,
      maxX: 622,
      maxY: 733,
    });

    expect(intervals.length).toBeLessThan(4_000);
  });
});

describe('morton bounds agreement', () => {
  const bounds = { minX: 0, minY: 0, maxX: 1000, maxY: 1000 };
  const xs = Array.from({ length: 64 }, (_, i) => (i * 997) % 1000);
  const ys = Array.from({ length: 64 }, (_, i) => (i * 613) % 1000);
  const codes = xs.map((x, i) => mortonCode2dForPoint(x, ys[i], bounds));

  it('agrees with the domain the codes came from', () => {
    expect(mortonBoundsAgreeWithCodes(xs, ys, codes, bounds)).toEqual({
      checked: 64,
      matched: 64,
    });
  });

  it('disagrees with a sub-box of that domain', () => {
    // The stale-fixture shape: a box a quarter the size, offset into the middle.
    const subBox = { minX: 250, minY: 250, maxX: 750, maxY: 750 };
    const { checked, matched } = mortonBoundsAgreeWithCodes(xs, ys, codes, subBox);
    expect(checked).toBe(64);
    expect(matched * 2).toBeLessThanOrEqual(checked);
  });

  it('stays inside the 32-bit code space at the top of the domain', () => {
    // x and y both maxed puts the y term in bit 31 — a `<< 1` would go negative here.
    const top = mortonCode2dForPoint(bounds.maxX, bounds.maxY, bounds);
    expect(top).toBe(2 ** 32 - 1);
    expect(top).toBeGreaterThan(0);
  });

  it('reports nothing to check rather than guessing, on empty or unusable input', () => {
    expect(mortonBoundsAgreeWithCodes([], [], [], bounds)).toEqual({ checked: 0, matched: 0 });
    expect(mortonBoundsAgreeWithCodes([Number.NaN], [0], [0], bounds)).toEqual({
      checked: 0,
      matched: 0,
    });
  });

  it('spreads its samples instead of taking a run of adjacent rows', () => {
    // Adjacent rows of a Morton-sorted group share a code prefix, so a leading slice
    // would agree or disagree together. Break only the tail and it must still be seen.
    const broken = [...codes];
    for (let i = 32; i < broken.length; i++) {
      broken[i] = 0;
    }
    const { checked, matched } = mortonBoundsAgreeWithCodes(xs, ys, broken, bounds, 8);
    expect(checked).toBe(8);
    expect(matched).toBeLessThan(checked);
  });
});

/**
 * A morton_code_2d column does not make a file Morton-sorted. A feature-primary
 * artifact carries the identical column with the identical values, unsorted, and the
 * row-group bisect run over it lands arbitrarily.
 */
describe('morton row-group sort detection', () => {
  it('accepts a monotonic sequence, including a shared boundary value', () => {
    expect(
      mortonRowGroupExtentsAreSorted([
        [0, 0],
        [10, 40],
        [40, 90],
        [91, 120],
      ])
    ).toBe(true);
  });

  it('rejects a sequence that restarts, as a feature-primary file does', () => {
    // Real shape: each feature block spans nearly the whole code range.
    expect(
      mortonRowGroupExtentsAreSorted([
        [0, 0],
        [450484663, 4193473654],
        [443527237, 4288997289],
      ])
    ).toBe(false);
  });

  it('rejects an extent that is not a range at all', () => {
    // `min > max` cannot come from healthy statistics, so it means the decode is wrong —
    // and a wrong decode is what this gate exists to keep tiling away from. Skipping it
    // would be worse than rejecting: `selectMortonRowGroups` treats an inverted range as
    // intersecting nothing, so that row group would be dropped from every query.
    expect(mortonRowGroupExtentsAreSorted([[90, 10]])).toBe(false);
    // Also as the first of several, where there is no previous max to trip over.
    expect(
      mortonRowGroupExtentsAreSorted([
        [90, 10],
        [100, 200],
      ])
    ).toBe(false);
    expect(mortonRowGroupExtentsAreSorted([[Number.NaN, 40]])).toBe(false);
    expect(mortonRowGroupExtentsAreSorted([[0, Number.POSITIVE_INFINITY]])).toBe(false);
  });

  it('separates "cannot verify" from "sorted"', () => {
    // The gate is a correctness check, so "no evidence" must not read as a pass.
    // Reachable two ways: no statistics parsed at all, and a column that carries none.
    expect(mortonRowGroupOrderVerdict([])).toBe('unverified');
    expect(mortonRowGroupOrderVerdict([null, null, null])).toBe('unverified');
    // ...both of which the boolean form answers `true` to, which is the whole reason
    // this exists.
    expect(mortonRowGroupExtentsAreSorted([])).toBe(true);
    expect(mortonRowGroupExtentsAreSorted([null, null, null])).toBe(true);

    expect(mortonRowGroupOrderVerdict([[0, 40], null, [50, 60]])).toBe('sorted');
    expect(
      mortonRowGroupOrderVerdict([
        [50, 60],
        [0, 40],
      ])
    ).toBe('unsorted');
  });

  it('treats a missing extent as unknown, not as a descent', () => {
    expect(mortonRowGroupExtentsAreSorted([[10, 40], null, [50, 60]])).toBe(true);
    // ...and does not lose the running maximum across the gap.
    expect(mortonRowGroupExtentsAreSorted([[10, 40], null, [20, 60]])).toBe(false);
  });

  it('concludes nothing from an empty index', () => {
    expect(mortonRowGroupExtentsAreSorted([])).toBe(true);
  });
});
