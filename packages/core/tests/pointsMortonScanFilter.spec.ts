import { tableFromArrays } from 'apache-arrow';
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
});
