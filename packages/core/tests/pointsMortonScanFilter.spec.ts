import { Float16, makeData, makeVector, tableFromArrays, vectorFromArray } from 'apache-arrow';
import { describe, expect, it } from 'vitest';
import {
  Float32PointBuffer,
  resolvePassthroughColumns,
  scanMortonTableInBounds,
} from '../src/workers/pointsScan.js';

/**
 * The tiled scan filters by feature code using a column it looks up by name. If
 * that column is not in the decoded chunk the scan cannot honour the filter at
 * all — and the failure mode matters, because nothing downstream checks.
 *
 * Passing every row means one selected gene renders as the whole dataset, in the
 * selection's colour, with no error logged. Matching nothing is also wrong, but
 * it shows up as "my gene has no points" rather than as plausible-looking data.
 */

function scan(columns: Record<string, unknown>, over: Record<string, unknown> = {}) {
  const xs = new Float32PointBuffer();
  const ys = new Float32PointBuffer();
  const zs = new Float32PointBuffer();
  scanMortonTableInBounds({
    table: tableFromArrays(columns as never),
    rowGroupIndex: 1, // past the sentinel window, so no rows are skipped for it
    bounds: { minX: -1e6, minY: -1e6, maxX: 1e6, maxY: 1e6 },
    axisNames: ['x', 'y'],
    mortonCodeColumnName: 'morton',
    xs,
    ys,
    zs,
    ...over,
  } as never);
  return Array.from(xs.toArray());
}

const withCodes = {
  x: Float32Array.from([0, 1, 2, 3]),
  y: Float32Array.from([0, 1, 2, 3]),
  morton: Int32Array.from([10, 11, 12, 13]),
  feature_name_codes: Int32Array.from([0, 1, 0, 2]),
};
const withoutCodes = {
  x: withCodes.x,
  y: withCodes.y,
  morton: withCodes.morton,
};

describe('morton scan — feature filter', () => {
  it('keeps only the requested codes when the column is present', () => {
    expect(
      scan(withCodes, { featureCodeColumnName: 'feature_name_codes', featureCodes: [0] })
    ).toEqual([0, 2]);
  });

  it('matches nothing when the filter cannot be honoured', () => {
    // Column named but absent from the decoded chunk.
    expect(
      scan(withoutCodes, { featureCodeColumnName: 'feature_name_codes', featureCodes: [0] })
    ).toEqual([]);
    // Filter requested with no column name at all.
    expect(scan(withoutCodes, { featureCodes: [0] })).toEqual([]);
  });

  it('still returns every in-bounds row when no filter was requested', () => {
    expect(scan(withoutCodes)).toEqual([0, 1, 2, 3]);
    expect(scan(withCodes, { featureCodeColumnName: 'feature_name_codes' })).toEqual([0, 1, 2, 3]);
  });
});

/**
 * Passthrough columns ride the scan for free — the row group's bytes are fetched
 * whole regardless — but "free" only holds if they stay in lockstep with the
 * geometry. A column that is one row short realigns every value after the first
 * bounds rejection, which reads as data rather than as an error.
 */
describe('morton scan — passthrough columns', () => {
  const table = {
    x: Float32Array.from([0, 100, 2, 3]),
    y: Float32Array.from([0, 100, 2, 3]),
    morton: Int32Array.from([10, 11, 12, 13]),
    qv: Float32Array.from([40, 41, 42, 43]),
    cell_id: ['a', 'b', 'c', 'd'],
    transcript_id: BigInt64Array.from([1n, 2n, 3n, 4n]),
  };

  function scanWithPassthrough(
    requested: string[],
    bounds = { minX: -1, minY: -1, maxX: 10, maxY: 10 }
  ) {
    const arrow = tableFromArrays(table as never);
    const resolved = resolvePassthroughColumns(arrow, requested, {
      axisNames: ['x', 'y'],
      mortonCodeColumnName: 'morton',
    });
    const xs = new Float32PointBuffer();
    const ys = new Float32PointBuffer();
    const zs = new Float32PointBuffer();
    scanMortonTableInBounds({
      table: arrow,
      rowGroupIndex: 1,
      bounds,
      axisNames: ['x', 'y'],
      mortonCodeColumnName: 'morton',
      xs,
      ys,
      zs,
      passthrough: resolved.columns,
    } as never);
    return {
      xs: Array.from(xs.toArray()),
      rejected: resolved.rejected,
      values: Object.fromEntries(
        resolved.columns.map((column) => [column.name, Array.from(column.buffer.toArray())])
      ),
    };
  }

  it('stays in lockstep with the geometry across a bounds rejection', () => {
    // Row 1 (x=100) falls outside the bounds, so its qv must be dropped with it.
    const result = scanWithPassthrough(['qv']);
    expect(result.xs).toEqual([0, 2, 3]);
    expect(result.values.qv).toEqual([40, 42, 43]);
  });

  it('refuses a column it cannot represent, rather than rounding it', () => {
    const result = scanWithPassthrough(['transcript_id', 'cell_id', 'nope']);
    expect(result.values).toEqual({});
    expect(result.rejected).toEqual([
      { name: 'transcript_id', reason: 'precision' },
      { name: 'cell_id', reason: 'not-numeric' },
      { name: 'nope', reason: 'missing' },
    ]);
  });

  it('ignores a request for a column the scan already returns', () => {
    const result = scanWithPassthrough(['x', 'morton', 'qv']);
    expect(Object.keys(result.values)).toEqual(['qv']);
    expect(result.rejected).toEqual([]);
  });

  /**
   * A tile spanning two row groups scans a second table with `rowIndex` restarting at
   * zero. Binding the values once, when the columns were resolved, paired the second
   * group's points with the first group's values — one value per point, so the
   * output-length checks could not see it.
   */
  it('reads values from the row group being scanned, not the one it resolved against', () => {
    const groupOne = tableFromArrays({
      x: Float32Array.from([0, 1]),
      y: Float32Array.from([0, 1]),
      morton: Int32Array.from([10, 11]),
      qv: Float32Array.from([10, 11]),
    } as never);
    const groupTwo = tableFromArrays({
      x: Float32Array.from([2, 3]),
      y: Float32Array.from([2, 3]),
      morton: Int32Array.from([12, 13]),
      qv: Float32Array.from([22, 33]),
    } as never);

    const context = { axisNames: ['x', 'y'], mortonCodeColumnName: 'morton' };
    const resolved = resolvePassthroughColumns(groupOne, ['qv'], context);
    const xs = new Float32PointBuffer();
    const ys = new Float32PointBuffer();
    const zs = new Float32PointBuffer();
    for (const table of [groupOne, groupTwo]) {
      scanMortonTableInBounds({
        table,
        rowGroupIndex: 1,
        bounds: { minX: -1e6, minY: -1e6, maxX: 1e6, maxY: 1e6 },
        ...context,
        xs,
        ys,
        zs,
        passthrough: resolved.columns,
      } as never);
    }

    expect(Array.from(xs.toArray())).toEqual([0, 1, 2, 3]);
    expect(Array.from(resolved.columns[0]?.buffer.toArray() ?? [])).toEqual([10, 11, 22, 33]);
  });

  it('carries a Bool column as 0/1 rather than NaN', () => {
    const arrow = tableFromArrays({
      x: Float32Array.from([0, 1]),
      y: Float32Array.from([0, 1]),
      morton: Int32Array.from([10, 11]),
      overlaps_nucleus: [true, false],
    } as never);
    const context = { axisNames: ['x', 'y'], mortonCodeColumnName: 'morton' };
    const resolved = resolvePassthroughColumns(arrow, ['overlaps_nucleus'], context);
    const xs = new Float32PointBuffer();
    const ys = new Float32PointBuffer();
    const zs = new Float32PointBuffer();
    scanMortonTableInBounds({
      table: arrow,
      rowGroupIndex: 1,
      bounds: { minX: -1e6, minY: -1e6, maxX: 1e6, maxY: 1e6 },
      ...context,
      xs,
      ys,
      zs,
      passthrough: resolved.columns,
    } as never);

    expect(resolved.rejected).toEqual([]);
    expect(Array.from(resolved.columns[0]?.buffer.toArray() ?? [])).toEqual([1, 0]);
  });

  /**
   * Arrow stores Float16 as `Uint16Array`, which IS an ArrayBuffer view, so the
   * null-free fast path in `numericColumnValues` hands back raw bit patterns: Float16
   * `1` arrives as `15360`. A NULLABLE fixture would pass without the fix, because
   * nulls force the boxed path that was already correct — so this one has no nulls.
   */
  it('decodes a null-free Float16 column instead of returning bit patterns', () => {
    // 15360 and 16384 are the Float16 bit patterns for 1 and 2. Built through
    // `makeData` so the vector really carries the Float16 TYPE over Uint16 storage —
    // `makeVector(new Uint16Array(...))` would infer Uint16 and prove nothing.
    const half = makeVector(
      makeData({ type: new Float16(), data: new Uint16Array([15360, 16384, 15360]) })
    );
    const arrow = tableFromArrays({
      x: Float32Array.from([0, 1, 2]),
      y: Float32Array.from([0, 1, 2]),
      morton: Int32Array.from([10, 11, 12]),
    } as never).assign(tableFromArrays({ pad: Int32Array.from([0, 0, 0]) } as never));
    const withHalf = arrow.assign(
      new (arrow.constructor as never as typeof arrow)({ qv: half } as never)
    );
    expect(withHalf.getChild('qv')?.nullCount).toBe(0);
    expect(withHalf.getChild('qv')?.type).toBeInstanceOf(Float16);

    const context = { axisNames: ['x', 'y'], mortonCodeColumnName: 'morton' };
    const resolved = resolvePassthroughColumns(withHalf, ['qv'], context);
    const xs = new Float32PointBuffer();
    const ys = new Float32PointBuffer();
    const zs = new Float32PointBuffer();
    scanMortonTableInBounds({
      table: withHalf,
      rowGroupIndex: 1,
      bounds: { minX: -1e6, minY: -1e6, maxX: 1e6, maxY: 1e6 },
      ...context,
      xs,
      ys,
      zs,
      passthrough: resolved.columns,
    } as never);

    expect(resolved.rejected).toEqual([]);
    expect(Array.from(resolved.columns[0]?.buffer.toArray() ?? [])).toEqual([1, 2, 1]);
  });

  it('keeps an Int32 above the Float32 integer limit exact', () => {
    const exact = 16_777_217; // 2^24 + 1, the first integer a Float32Array rounds
    const arrow = tableFromArrays({
      x: Float32Array.from([0]),
      y: Float32Array.from([0]),
      morton: Int32Array.from([10]),
      codeword_index: Int32Array.from([exact]),
    } as never);
    const context = { axisNames: ['x', 'y'], mortonCodeColumnName: 'morton' };
    const resolved = resolvePassthroughColumns(arrow, ['codeword_index'], context);
    const xs = new Float32PointBuffer();
    const ys = new Float32PointBuffer();
    const zs = new Float32PointBuffer();
    scanMortonTableInBounds({
      table: arrow,
      rowGroupIndex: 1,
      bounds: { minX: -1e6, minY: -1e6, maxX: 1e6, maxY: 1e6 },
      ...context,
      xs,
      ys,
      zs,
      passthrough: resolved.columns,
    } as never);

    expect(resolved.columns[0]?.buffer.toArray()[0]).toBe(exact);
  });
});
