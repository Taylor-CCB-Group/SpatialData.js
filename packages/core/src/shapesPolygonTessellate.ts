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
 * Rings are exterior-only and simple (no holes) — matching the WKB decode, which
 * extracts `getCoordinates()[0]`. Lives in core so the geometry worker can run it
 * right after decoding and transfer the buffers back (off the main thread); the
 * renderer keeps a main-thread fallback for the no-worker path.
 */

import earcutModule from 'earcut';

// earcut v3 ships as an ES module; tolerate both default and namespace interop.
const earcut =
  (earcutModule as unknown as { default?: typeof earcutModule }).default ?? earcutModule;

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
  /** Per-feature characteristic size (√area, world units), one per ring/feature. The
   *  shader uses it to keep the outline from dominating when a shape is small on
   *  screen. Length `ringCount`. */
  featureScale: Float32Array;
}

/** True if ring vertices `p` and `q` are adjacent in a ring of `n` (mod n). */
function isBoundaryEdge(p: number, q: number, n: number): boolean {
  const d = Math.abs(p - q);
  return d === 1 || d === n - 1;
}

/**
 * Tessellate flat polygon rings (interleaved positions + per-ring `startIndices`)
 * into shared ring positions + per-triangle topology. Non-polygon / degenerate rings
 * (< 3 distinct vertices) are skipped.
 */
export function tessellateFlatPolygons(
  positions: Float32Array,
  startIndices: Int32Array
): TessellatedPolygons {
  const ringCount = Math.max(0, startIndices.length - 1);

  // Pass 1: per-ring unique length + earcut; count triangles and ring vertices.
  let triangleCount = 0;
  let ringVertexCount = 0;
  const ringTris: (number[] | Uint32Array)[] = new Array(ringCount);
  const ringLen = new Int32Array(ringCount);
  const ringVertStart = new Int32Array(ringCount);
  for (let r = 0; r < ringCount; r += 1) {
    const start = startIndices[r];
    const end = startIndices[r + 1];
    let n = end - start;
    // Drop a closing duplicate vertex (WKB rings are closed: last == first).
    if (n >= 2) {
      const fx = positions[start * 2];
      const fy = positions[start * 2 + 1];
      const lx = positions[(end - 1) * 2];
      const ly = positions[(end - 1) * 2 + 1];
      if (fx === lx && fy === ly) {
        n -= 1;
      }
    }
    ringVertStart[r] = ringVertexCount;
    ringLen[r] = n;
    if (n < 3) {
      ringTris[r] = [];
      continue;
    }
    ringVertexCount += n;
    const coords = new Float64Array(n * 2);
    for (let i = 0; i < n; i += 1) {
      coords[i * 2] = positions[(start + i) * 2];
      coords[i * 2 + 1] = positions[(start + i) * 2 + 1];
    }
    const tris = earcut(coords);
    ringTris[r] = tris;
    triangleCount += tris.length / 3;
  }

  const ringPositions = new Float32Array(ringVertexCount * 2);
  const triangleData = new Uint32Array(triangleCount * 4);

  // Fill the shared ring positions.
  for (let r = 0; r < ringCount; r += 1) {
    const n = ringLen[r];
    if (n < 3) {
      continue;
    }
    const start = startIndices[r];
    const base = ringVertStart[r];
    for (let i = 0; i < n; i += 1) {
      ringPositions[(base + i) * 2] = positions[(start + i) * 2];
      ringPositions[(base + i) * 2 + 1] = positions[(start + i) * 2 + 1];
    }
  }

  // Fill the per-triangle topology and accumulate each feature's area.
  const featureScale = new Float32Array(ringCount);
  let t = 0;
  for (let r = 0; r < ringCount; r += 1) {
    const tris = ringTris[r];
    if (!tris || tris.length === 0) {
      continue;
    }
    const n = ringLen[r];
    const base = ringVertStart[r];
    const start = startIndices[r];
    let area = 0;
    for (let k = 0; k < tris.length; k += 3) {
      const ia = tris[k];
      const ib = tris[k + 1];
      const ic = tris[k + 2];
      const bd0 = isBoundaryEdge(ib, ic, n) ? 1 : 0; // BC (opposite A)
      const bd1 = isBoundaryEdge(ic, ia, n) ? 1 : 0; // CA (opposite B)
      const bd2 = isBoundaryEdge(ia, ib, n) ? 1 : 0; // AB (opposite C)
      const flags = bd0 | (bd1 << 1) | (bd2 << 2);
      triangleData[t * 4] = base + ia;
      triangleData[t * 4 + 1] = base + ib;
      triangleData[t * 4 + 2] = base + ic;
      // feature index is the ring index; pack it above the 3 flag bits.
      triangleData[t * 4 + 3] = r * 8 + flags;
      t += 1;

      const ax = positions[(start + ia) * 2];
      const ay = positions[(start + ia) * 2 + 1];
      const bx = positions[(start + ib) * 2];
      const by = positions[(start + ib) * 2 + 1];
      const cx = positions[(start + ic) * 2];
      const cy = positions[(start + ic) * 2 + 1];
      area += Math.abs((bx - ax) * (cy - ay) - (by - ay) * (cx - ax)) * 0.5;
    }
    // √area ≈ the shape's characteristic side/diameter in world units.
    featureScale[r] = Math.sqrt(area);
  }

  return { ringPositions, triangleData, triangleCount, ringVertexCount, featureScale };
}
