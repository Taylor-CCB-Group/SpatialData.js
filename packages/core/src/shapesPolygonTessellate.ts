/**
 * Tessellate flat polygon rings into **compact topology** for a vertex-pulling
 * renderer (`FlatPolygonLayer`): a shared ring-position array plus a per-triangle
 * record. The vertex shader reconstructs each vertex's position and its boundary
 * edge-distance from `gl_VertexID` + these two buffers (uploaded as textures), so
 * nothing is stored per de-indexed vertex — positions are shared, and the
 * edge-distance is *computed*, not stored.
 *
 * THE OUTLINE ENCODING. A filled polygon is earcut into triangles; a fragment has no
 * idea where the real polygon boundary is, and a naive wireframe would light up the
 * internal earcut edges (diagonals). We record, per triangle, which of its three
 * edges are true polygon-boundary edges (an edge is a boundary edge iff its two
 * endpoints are consecutive in the ring, mod ring length). The shader turns those
 * flags into a `vec3` of edge-distances — the triangle height at the opposite vertex
 * for a boundary edge, a large sentinel for an internal one — so `min(vec3)` in the
 * fragment is the distance to the nearest *boundary* edge, and only the outline draws.
 *
 * Each polygon part is earcut with its holes; a feature's parts all carry its
 * feature index. Lives in core so the geometry worker can run it right after
 * decoding and transfer the buffers back (off the main thread); the renderer keeps
 * a main-thread fallback for the no-worker path.
 */

import earcutModule from 'earcut';

// earcut v3 ships as an ES module; tolerate both default and namespace interop.
const earcut =
  (earcutModule as unknown as { default?: typeof earcutModule }).default ?? earcutModule;

/**
 * GeoArrow MultiPolygon offsets over a flat `positions` buffer:
 * feature → polygon part → ring → vertex. A part's first ring is its exterior,
 * the rest are holes.
 */
export interface PolygonPartOffsets {
  /** Polygon-part offset per feature; length `featureCount + 1`. */
  geometryOffsets: Int32Array;
  /** Ring offset per polygon part; length `polygonCount + 1`. */
  polygonOffsets: Int32Array;
  /** Vertex offset per ring; length `ringCount + 1`. */
  ringOffsets: Int32Array;
}

export interface TessellatedPolygons {
  /** Shared ring vertices, interleaved XY (closing duplicates dropped). Length
   *  `2 * ringVertexCount`. Indexed by the triangle records. */
  ringPositions: Float32Array;
  /** Per-triangle record `[g0, g1, g2, feature*8 + boundaryFlags]`, where `g*` are
   *  ring-vertex indices and the low 3 bits flag which edges are boundary edges
   *  (bit0: edge BC = g1→g2, bit1: edge CA = g2→g0, bit2: edge AB = g0→g1). Length
   *  `4 * triangleCount`. */
  triangleData: Uint32Array;
  triangleCount: number;
  ringVertexCount: number;
  /** Per-feature characteristic size (√filled area, world units). The shader uses it
   *  to keep the outline from dominating when a shape is small on screen. Length
   *  `featureCount`. */
  featureScale: Float32Array;
}

/** Ring length with a closing duplicate vertex dropped (WKB rings are closed). */
function openRingLength(positions: Float32Array, start: number, end: number): number {
  const n = end - start;
  if (
    n >= 2 &&
    positions[start * 2] === positions[(end - 1) * 2] &&
    positions[start * 2 + 1] === positions[(end - 1) * 2 + 1]
  ) {
    return n - 1;
  }
  return n;
}

const EMPTY_TRIS: number[] = [];

/**
 * Tessellate flat polygons into shared ring positions + per-triangle topology.
 * Without `parts`, each feature is one simple ring at `startIndices` (feature →
 * vertex offsets). Degenerate rings (< 3 distinct vertices) are skipped; a
 * degenerate exterior skips its whole part.
 */
export function tessellateFlatPolygons(
  positions: Float32Array,
  startIndices: Int32Array,
  parts?: PolygonPartOffsets
): TessellatedPolygons {
  const featureCount = Math.max(0, startIndices.length - 1);
  const ringOffsets = parts?.ringOffsets ?? startIndices;
  const polygonOffsets = parts?.polygonOffsets;
  const geometryOffsets = parts?.geometryOffsets;
  const polygonCount = polygonOffsets ? polygonOffsets.length - 1 : featureCount;
  const ringCount = Math.max(0, ringOffsets.length - 1);
  const firstRing = (p: number) => (polygonOffsets ? polygonOffsets[p] : p);
  const firstPolygon = (f: number) => (geometryOffsets ? geometryOffsets[f] : f);

  // Pass 1: per-part kept ring lengths + earcut (with hole indices); count output.
  const ringLen = new Int32Array(ringCount);
  const polyTris: ArrayLike<number>[] = new Array(polygonCount);
  const polyVertStart = new Int32Array(polygonCount);
  let triangleCount = 0;
  let ringVertexCount = 0;
  let maxPolyVerts = 0;
  for (let p = 0; p < polygonCount; p += 1) {
    const r0 = firstRing(p);
    const r1 = firstRing(p + 1);
    let n = 0;
    for (let r = r0; r < r1; r += 1) {
      const len = openRingLength(positions, ringOffsets[r], ringOffsets[r + 1]);
      if (len < 3) {
        if (r === r0) break;
        continue;
      }
      ringLen[r] = len;
      n += len;
    }
    polyVertStart[p] = ringVertexCount;
    if (n === 0) {
      polyTris[p] = EMPTY_TRIS;
      continue;
    }
    const coords = new Float64Array(n * 2);
    const holes: number[] = [];
    let k = 0;
    for (let r = r0; r < r1; r += 1) {
      const len = ringLen[r];
      if (len === 0) continue;
      if (r !== r0) holes.push(k);
      const src = ringOffsets[r];
      for (let i = 0; i < len; i += 1) {
        coords[(k + i) * 2] = positions[(src + i) * 2];
        coords[(k + i) * 2 + 1] = positions[(src + i) * 2 + 1];
      }
      k += len;
    }
    const tris = earcut(coords, holes.length > 0 ? holes : undefined);
    polyTris[p] = tris;
    triangleCount += tris.length / 3;
    ringVertexCount += n;
    maxPolyVerts = Math.max(maxPolyVerts, n);
  }

  const ringPositions = new Float32Array(ringVertexCount * 2);
  const triangleData = new Uint32Array(triangleCount * 4);
  const featureScale = new Float32Array(featureCount);
  // Per local vertex of the current part: its ring's local start and length, so an
  // edge is a boundary edge iff both ends share a ring and are adjacent in it.
  const vRingStart = new Int32Array(maxPolyVerts);
  const vRingLen = new Int32Array(maxPolyVerts);
  const isBoundaryEdge = (a: number, b: number): boolean => {
    if (vRingStart[a] !== vRingStart[b]) return false;
    const d = Math.abs(a - b);
    return d === 1 || d === vRingLen[a] - 1;
  };

  // Pass 2: fill shared positions + per-triangle topology; accumulate feature area.
  let t = 0;
  for (let f = 0; f < featureCount; f += 1) {
    let area = 0;
    for (let p = firstPolygon(f); p < firstPolygon(f + 1); p += 1) {
      const tris = polyTris[p];
      if (tris.length === 0) continue;
      const base = polyVertStart[p];
      let k = 0;
      for (let r = firstRing(p); r < firstRing(p + 1); r += 1) {
        const len = ringLen[r];
        const src = ringOffsets[r];
        for (let i = 0; i < len; i += 1) {
          ringPositions[(base + k + i) * 2] = positions[(src + i) * 2];
          ringPositions[(base + k + i) * 2 + 1] = positions[(src + i) * 2 + 1];
          vRingStart[k + i] = k;
          vRingLen[k + i] = len;
        }
        k += len;
      }
      for (let j = 0; j < tris.length; j += 3) {
        const ia = tris[j];
        const ib = tris[j + 1];
        const ic = tris[j + 2];
        const flags =
          (isBoundaryEdge(ib, ic) ? 1 : 0) | // BC (opposite A)
          (isBoundaryEdge(ic, ia) ? 2 : 0) | // CA (opposite B)
          (isBoundaryEdge(ia, ib) ? 4 : 0); // AB (opposite C)
        triangleData[t * 4] = base + ia;
        triangleData[t * 4 + 1] = base + ib;
        triangleData[t * 4 + 2] = base + ic;
        triangleData[t * 4 + 3] = f * 8 + flags;
        t += 1;

        const ax = ringPositions[(base + ia) * 2];
        const ay = ringPositions[(base + ia) * 2 + 1];
        const bx = ringPositions[(base + ib) * 2];
        const by = ringPositions[(base + ib) * 2 + 1];
        const cx = ringPositions[(base + ic) * 2];
        const cy = ringPositions[(base + ic) * 2 + 1];
        area += Math.abs((bx - ax) * (cy - ay) - (by - ay) * (cx - ax)) * 0.5;
      }
    }
    // √area ≈ the shape's characteristic side/diameter in world units.
    featureScale[f] = Math.sqrt(area);
  }

  return { ringPositions, triangleData, triangleCount, ringVertexCount, featureScale };
}
