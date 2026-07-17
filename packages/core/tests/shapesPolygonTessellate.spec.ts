import { describe, expect, it } from 'vitest';
import { tessellateFlatPolygons } from '../src/shapesPolygonTessellate';

/**
 * The vertex-pulling topology + boundary-edge encoding. The vertex shader will, per
 * triangle corner, turn the boundary flags into a `vec3` of edge-distances; the
 * fragment draws the outline where `min(vec3)` is ~0. This test replicates that
 * shader computation in JS from `triangleData` + `ringPositions`, and asserts the
 * invariant: at an edge midpoint the nearest-boundary distance is ~0 for a real
 * polygon boundary edge and strictly positive for an internal (earcut) edge.
 */

/** Replicate the shader's per-corner edge-distance `vec3` (matches the VS logic). */
function cornerEdgeDist(
  A: [number, number],
  B: [number, number],
  C: [number, number],
  flags: number,
  corner: number
): [number, number, number] {
  const crossMag = Math.abs((B[0] - A[0]) * (C[1] - A[1]) - (B[1] - A[1]) * (C[0] - A[0]));
  const lenBC = Math.hypot(B[0] - C[0], B[1] - C[1]);
  const lenCA = Math.hypot(C[0] - A[0], C[1] - A[1]);
  const lenAB = Math.hypot(A[0] - B[0], A[1] - B[1]);
  const hA = lenBC > 0 ? crossMag / lenBC : 0;
  const hB = lenCA > 0 ? crossMag / lenCA : 0;
  const hC = lenAB > 0 ? crossMag / lenAB : 0;
  const large = Math.max(hA, hB, hC) * 8 + 1;
  const bd0 = (flags & 1) !== 0; // BC
  const bd1 = (flags & 2) !== 0; // CA
  const bd2 = (flags & 4) !== 0; // AB
  if (corner === 0) return [bd0 ? hA : large, bd1 ? 0 : large, bd2 ? 0 : large];
  if (corner === 1) return [bd0 ? 0 : large, bd1 ? hB : large, bd2 ? 0 : large];
  return [bd0 ? 0 : large, bd1 ? 0 : large, bd2 ? hC : large];
}

/** Barycentric interpolation of the three corners' vec3, then min — what the GPU does. */
function minEdgeDistanceAt(
  A: [number, number],
  B: [number, number],
  C: [number, number],
  eA: [number, number, number],
  eB: [number, number, number],
  eC: [number, number, number],
  px: number,
  py: number
): number {
  const det = (B[1] - C[1]) * (A[0] - C[0]) + (C[0] - B[0]) * (A[1] - C[1]);
  const wA = ((B[1] - C[1]) * (px - C[0]) + (C[0] - B[0]) * (py - C[1])) / det;
  const wB = ((C[1] - A[1]) * (px - C[0]) + (A[0] - C[0]) * (py - C[1])) / det;
  const wC = 1 - wA - wB;
  return Math.min(
    wA * eA[0] + wB * eB[0] + wC * eC[0],
    wA * eA[1] + wB * eB[1] + wC * eC[1],
    wA * eA[2] + wB * eB[2] + wC * eC[2]
  );
}

describe('tessellateFlatPolygons', () => {
  it('emits shared ring positions + topology, drawing boundary edges only', () => {
    // A closed unit square (last vertex repeats the first).
    const positions = new Float32Array([0, 0, 1, 0, 1, 1, 0, 1, 0, 0]);
    const startIndices = new Int32Array([0, 5]);

    const { ringPositions, triangleData, triangleCount, ringVertexCount, featureScale } =
      tessellateFlatPolygons(positions, startIndices);

    // 4-vertex square (closing dropped) ⇒ 4 shared ring vertices, 2 triangles.
    expect(ringVertexCount).toBe(4);
    expect(triangleCount).toBe(2);
    expect(Array.from(ringPositions)).toEqual([0, 0, 1, 0, 1, 1, 0, 1]);
    // Unit square → area 1 → √area = 1 (the shape's characteristic size).
    expect(featureScale.length).toBe(1);
    expect(featureScale[0]).toBeCloseTo(1, 6);

    const isSquareBoundary = (p: [number, number], q: [number, number]): boolean => {
      const onVert = (p[0] === 0 && q[0] === 0) || (p[0] === 1 && q[0] === 1);
      const onHorz = (p[1] === 0 && q[1] === 0) || (p[1] === 1 && q[1] === 1);
      return onVert || onHorz;
    };
    const pos = (g: number): [number, number] => [ringPositions[g * 2], ringPositions[g * 2 + 1]];

    for (let t = 0; t < triangleCount; t += 1) {
      const g0 = triangleData[t * 4];
      const g1 = triangleData[t * 4 + 1];
      const g2 = triangleData[t * 4 + 2];
      const packed = triangleData[t * 4 + 3];
      expect(packed >>> 3).toBe(0); // feature index of ring 0
      const flags = packed & 7;
      const A = pos(g0);
      const B = pos(g1);
      const C = pos(g2);
      const eA = cornerEdgeDist(A, B, C, flags, 0);
      const eB = cornerEdgeDist(A, B, C, flags, 1);
      const eC = cornerEdgeDist(A, B, C, flags, 2);

      const corners: [number, number][] = [A, B, C];
      for (let i = 0; i < 3; i += 1) {
        const p = corners[i];
        const q = corners[(i + 1) % 3];
        const d = minEdgeDistanceAt(A, B, C, eA, eB, eC, (p[0] + q[0]) / 2, (p[1] + q[1]) / 2);
        if (isSquareBoundary(p, q)) {
          expect(d).toBeCloseTo(0, 5); // real boundary edge → drawn
        } else {
          expect(d).toBeGreaterThan(0.4); // diagonal midpoint is 0.5 from a side → suppressed
        }
      }
    }
  });

  it('skips degenerate rings (< 3 distinct vertices)', () => {
    const positions = new Float32Array([0, 0, 1, 1, 0, 0]);
    const startIndices = new Int32Array([0, 3]);
    const { triangleCount, ringVertexCount } = tessellateFlatPolygons(positions, startIndices);
    expect(triangleCount).toBe(0);
    expect(ringVertexCount).toBe(0);
  });
});
