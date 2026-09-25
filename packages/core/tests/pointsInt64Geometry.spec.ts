import { tableFromArrays } from 'apache-arrow';
import { describe, expect, it } from 'vitest';
import { toNumberValues } from '../src/arrowNumbers.js';
import { resolveRowFeatureCodesFromTable } from '../src/pointsFeatures.js';
import { MORTON_CODE_2D_COLUMN } from '../src/pointsTiling.js';
import {
  extractGeometryColumnar,
  Float32PointBuffer,
  Int32PointBuffer,
  scanMortonTableInBounds,
} from '../src/workers/pointsScan.js';

/**
 * Integer point coordinates, which every reader here has to survive.
 *
 * Nothing in the format says a coordinate is a float, and pandas and dask write
 * whole numbers as `int64` unless told otherwise — spatialdata's own `blobs_points`
 * is `x: int64, y: int64`. Arrow surfaces that as a `BigInt64Array`, a real
 * `ArrayBuffer` view whose elements are `bigint`, so it passes every "already typed"
 * check and then throws on contact with a number. The synthetic fixtures used to be
 * float64 throughout, which is how a whole release shipped unable to load one of
 * these: the geometry reached the deck layer as `BigInt64Array` and every path that
 * tried to narrow it first threw instead.
 */
function int64PointsTable() {
  return tableFromArrays({
    x: BigInt64Array.from([10n, 20n, 30n, 40n]),
    y: BigInt64Array.from([15n, 25n, 35n, 45n]),
    [MORTON_CODE_2D_COLUMN]: Int32Array.from([0, 1, 2, 3]),
    gene_codes: BigInt64Array.from([0n, 1n, 0n, 1n]),
  });
}

describe('int64 geometry columns', () => {
  it('widens an int64 lane to numbers and leaves other lanes alone', () => {
    const widened = toNumberValues(BigInt64Array.from([1n, -2n, 3n]));
    expect(Array.from(widened)).toEqual([1, -2, 3]);

    // Anything already numeric comes back as the same object — the conversion must
    // not cost a copy on the float columns that take this path on every row group.
    const floats = Float32Array.from([1.5, 2.5]);
    expect(toNumberValues(floats)).toBe(floats);
  });

  it('decodes int64 x/y in the one-shot geometry decode', () => {
    const geometry = extractGeometryColumnar(int64PointsTable(), ['x', 'y']);
    expect(geometry.shape).toEqual([2, 4]);
    expect(Array.from(geometry.xs)).toEqual([10, 20, 30, 40]);
    expect(Array.from(geometry.ys)).toEqual([15, 25, 35, 45]);
  });

  it('scans int64 x/y on the tiled in-bounds path', () => {
    const xs = new Float32PointBuffer();
    const ys = new Float32PointBuffer();
    const codes = new Int32PointBuffer();
    scanMortonTableInBounds({
      table: int64PointsTable(),
      rowGroupIndex: 0,
      bounds: { minX: 15, maxX: 35, minY: 0, maxY: 100 },
      axisNames: ['x', 'y'],
      mortonCodeColumnName: MORTON_CODE_2D_COLUMN,
      featureCodeColumnName: 'gene_codes',
      xs,
      ys,
      zs: new Float32PointBuffer(),
      codes,
    });
    expect(Array.from(xs.toArray())).toEqual([20, 30]);
    expect(Array.from(ys.toArray())).toEqual([25, 35]);
    expect(Array.from(codes.toArray())).toEqual([1, 0]);
  });

  it('scans a NULLABLE int64 x/y, which takes the boxed read', () => {
    // `nullCount > 0` routes past the typed fast path onto `Vector.get`, which hands
    // back a `bigint`. Read as "not a number" that is a full-length NaN array — the
    // same wrong answer as the throw, minus the throw.
    const table = tableFromArrays({
      x: [10n, null, 30n],
      y: [15n, 25n, 35n],
      // Non-zero: the scan drops Morton sentinel rows, and 0 is one.
      [MORTON_CODE_2D_COLUMN]: Int32Array.from([1, 2, 3]),
    });
    const xs = new Float32PointBuffer();
    const ys = new Float32PointBuffer();
    scanMortonTableInBounds({
      table,
      rowGroupIndex: 0,
      bounds: { minX: 0, maxX: 100, minY: 0, maxY: 100 },
      axisNames: ['x', 'y'],
      mortonCodeColumnName: MORTON_CODE_2D_COLUMN,
      xs,
      ys,
      zs: new Float32PointBuffer(),
    });
    // The null row drops out — a point at NaN cannot render — and the rest survive
    // as themselves rather than joining it.
    expect(Array.from(xs.toArray())).toEqual([10, 30]);
    expect(Array.from(ys.toArray())).toEqual([15, 35]);
  });

  it('reads an int64 feature-code column as numbers', () => {
    const resolved = resolveRowFeatureCodesFromTable(int64PointsTable(), 'gene', 'gene_codes');
    expect(resolved).toBeDefined();
    expect(Array.from(resolved ?? [])).toEqual([0, 1, 0, 1]);
  });
});
