import type { Vector } from 'apache-arrow/vector';
import WKB from 'ol/format/WKB.js';
import MultiPolygon from 'ol/geom/MultiPolygon.js';
import Point from 'ol/geom/Point.js';
import Polygon from 'ol/geom/Polygon.js';
import { describe, expect, it } from 'vitest';
import {
  decodeWkbPointColumnFlat,
  decodeWkbPolygonColumnFlat,
} from '../src/shapesGeometryDecode.js';

/**
 * The WKB→flat-buffer decode, the CPU-heavy half of shapes loading that now runs
 * off-thread. The claims under test are the flattening ones: ring coordinates
 * land interleaved in `positions`, `startIndices` slices them back into features,
 * and `parts` recovers the part/hole structure. Round-tripped through
 * ol's own WKB writer so it exercises the real parse, not a hand-rolled fixture.
 */

function toBytes(written: string | ArrayBuffer | Uint8Array): Uint8Array {
  if (written instanceof Uint8Array) {
    return written;
  }
  if (typeof written !== 'string') {
    return new Uint8Array(written);
  }
  // ol writes WKB as a hex string; parquet delivers bytes, so decode to match.
  const bytes = new Uint8Array(written.length / 2);
  for (let i = 0; i < bytes.length; i += 1) {
    bytes[i] = Number.parseInt(written.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

function wkbColumn(geometries: Array<Polygon | MultiPolygon | Point>): Vector {
  const wkb = new WKB();
  const buffers = geometries.map((g) => toBytes(wkb.writeGeometry(g)));
  return { toArray: () => buffers } as unknown as Vector;
}

describe('decodeWkbPolygonColumnFlat', () => {
  it('flattens exterior rings and indexes them per feature', () => {
    // A triangle (3 verts) and a square (4 verts). Rings are closed in WKB but ol
    // returns the ring as written; assert against what the writer round-trips.
    const triangle = new Polygon([
      [
        [0, 0],
        [2, 0],
        [1, 2],
        [0, 0],
      ],
    ]);
    const square = new Polygon([
      [
        [10, 10],
        [12, 10],
        [12, 12],
        [10, 12],
        [10, 10],
      ],
    ]);

    const result = decodeWkbPolygonColumnFlat(wkbColumn([triangle, square]));

    expect(result.kind).toBe('polygon');
    expect(result.featureCount).toBe(2);
    // startIndices are vertex offsets: feature 0 starts at 0, feature 1 after the
    // triangle's ring, and the terminal entry is the total vertex count.
    const triangleVerts = result.startIndices[1];
    expect(result.startIndices[0]).toBe(0);
    expect(result.startIndices[2]).toBe(result.positions.length / 2);
    // Each vertex is two floats.
    expect(result.positions.length).toBe(result.startIndices[2] * 2);
    // Feature 0's first vertex is the triangle's first coordinate.
    expect(result.positions[0]).toBe(0);
    expect(result.positions[1]).toBe(0);
    // Feature 1's first vertex is the square's first coordinate.
    expect(result.positions[triangleVerts * 2]).toBe(10);
    expect(result.positions[triangleVerts * 2 + 1]).toBe(10);
  });

  it('keeps holes and every MultiPolygon part, indexed feature → part → ring', () => {
    const square = (x: number, y: number, s: number): Array<[number, number]> => [
      [x, y],
      [x + s, y],
      [x + s, y + s],
      [x, y + s],
      [x, y],
    ];
    const holed = new Polygon([square(0, 0, 4), square(1, 1, 1), square(2, 2, 1)]);
    const multi = new MultiPolygon([[square(10, 10, 2)], [square(20, 20, 4), square(21, 21, 1)]]);

    const result = decodeWkbPolygonColumnFlat(wkbColumn([holed, multi]));

    expect(result.featureCount).toBe(2);
    expect(result.parts).toBeDefined();
    const { geometryOffsets, polygonOffsets, ringOffsets } = result.parts ?? {};
    // Feature 0 is one part; feature 1 is two.
    expect(Array.from(geometryOffsets ?? [])).toEqual([0, 1, 3]);
    // Part 0: exterior + 2 holes; part 1: exterior; part 2: exterior + 1 hole.
    expect(Array.from(polygonOffsets ?? [])).toEqual([0, 3, 4, 6]);
    // Six closed 5-vertex rings.
    expect(Array.from(ringOffsets ?? [])).toEqual([0, 5, 10, 15, 20, 25, 30]);
    // startIndices still slices whole features: every ring of a feature is contiguous.
    expect(Array.from(result.startIndices)).toEqual([0, 15, 30]);
    expect(result.positions.length).toBe(60);
    // Second hole of feature 0, and the second part of feature 1, are present.
    expect([result.positions[20], result.positions[21]]).toEqual([2, 2]);
    expect([result.positions[40], result.positions[41]]).toEqual([20, 20]);
  });
});

describe('decodeWkbPointColumnFlat', () => {
  it('decodes one coordinate per feature into xs/ys', () => {
    const result = decodeWkbPointColumnFlat(wkbColumn([new Point([3, 4]), new Point([5, 6])]));
    expect(result.kind).toBe('point');
    expect(result.featureCount).toBe(2);
    expect(Array.from(result.xs)).toEqual([3, 5]);
    expect(Array.from(result.ys)).toEqual([4, 6]);
  });
});
