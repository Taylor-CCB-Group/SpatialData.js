import type { Table as ArrowTable } from 'apache-arrow';
import { describe, expect, it } from 'vitest';
import {
  extractSentinelBoundingBox,
  filterPointsToBounds,
  mergeAdjacentIntervals,
  mortonIntervalsForBounds,
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
});
