// Worker-safe WKB → flat-buffer shape geometry decode.
//
// This is the CPU-heavy half of shapes loading — the WKB parse — factored out of
// `VShapesSource` so it can run *either* on the main thread (fallback) or inside
// the points worker. It depends only on `apache-arrow` + `ol/format/WKB`, never on
// zarrita/the store, so it is safe to import into the worker bundle.
//
// It produces **flat GeoArrow-style typed arrays** (interleaved coordinates +
// vertex offsets) rather than the historical `Array<Array<[number, number]>>`.
// Flat buffers are transferable across the worker boundary zero-copy and feed a
// binary deck.gl `PolygonLayer` directly — no per-vertex JS object ever exists.

import type { Table as ArrowTable } from 'apache-arrow';
import type { Vector } from 'apache-arrow/vector';
import WKB from 'ol/format/WKB.js';
import type { TessellatedPolygons } from './shapesPolygonTessellate.js';

export interface FlatPolygonGeometry {
  kind: 'polygon';
  /** Interleaved exterior-ring coordinates `[x0, y0, x1, y1, …]` for all features. */
  positions: Float32Array;
  /**
   * Vertex offset where each feature's ring begins; length `featureCount + 1`,
   * last entry = total vertex count. This is deck.gl's binary `startIndices`.
   */
  startIndices: Int32Array;
  featureCount: number;
  /** Vertex-pulling render topology, tessellated in the worker. Absent on the
   *  main-thread decode path (the renderer tessellates lazily there). */
  tessellation?: TessellatedPolygons;
}

export interface FlatPointGeometry {
  kind: 'point';
  xs: Float32Array;
  ys: Float32Array;
  featureCount: number;
}

export type FlatShapeGeometry = FlatPolygonGeometry | FlatPointGeometry;

/** Extract the geometry column and assert it is Arrow `Binary` (WKB bytes). */
export function getBinaryGeometryColumn(table: ArrowTable, columnName: string): Vector {
  const geometryColumn = table.getChild(columnName);
  if (!geometryColumn) {
    throw new Error(`Column ${columnName} not found in parquet table`);
  }
  if (geometryColumn.type.toString() !== 'Binary') {
    throw new Error(
      `Expected geometry column to have Binary type but got ${geometryColumn.type.toString()}`
    );
  }
  return geometryColumn;
}

/**
 * Whether the geometry column is WKB-encoded. Mirrors GeoPandas' convention: the
 * `ARROW:extension:name` field metadata is `geoarrow.wkb` when present, and absent
 * metadata (pre-1.0.0 geopandas) is treated as WKB. GeoArrow-native encodings are
 * not yet supported here (that is the tiled-artifact path — see ADR 0002).
 */
export function isWkbColumn(table: ArrowTable, columnName: string): boolean {
  const encoding = table.schema.fields
    .find((field) => field.name === columnName)
    ?.metadata?.get('ARROW:extension:name');
  if (!encoding) {
    return true;
  }
  return encoding === 'geoarrow.wkb';
}

/**
 * The exterior ring of a decoded WKB geometry's coordinate tree, matching the
 * historical `getCoordinates()[0]` behaviour exactly:
 *
 *  - Polygon      → `coords[0]` IS the exterior ring (`[[x,y], …]`). Holes dropped.
 *  - MultiPolygon → `coords[0]` is the first sub-polygon's rings; take its
 *    exterior (`coords[0][0]`). Remaining sub-polygons + holes dropped.
 *
 * Returns `null` for anything that doesn't shape like a ring, so the caller can
 * emit an empty feature rather than throw on stray geometry.
 */
function exteriorRing(coordinateTree: unknown): ReadonlyArray<readonly [number, number]> | null {
  if (!Array.isArray(coordinateTree) || coordinateTree.length === 0) {
    return null;
  }
  const first = coordinateTree[0];
  if (Array.isArray(first) && typeof first[0] === 'number') {
    // coordinateTree is already a ring: [[x, y], …]
    return coordinateTree as ReadonlyArray<readonly [number, number]>;
  }
  if (Array.isArray(first) && Array.isArray(first[0])) {
    // coordinateTree is an array of rings (MultiPolygon's first sub-polygon).
    return first as ReadonlyArray<readonly [number, number]>;
  }
  return null;
}

/**
 * Decode a WKB polygon column into flat exterior-ring positions + `startIndices`.
 *
 * Two passes so the output buffers are exactly sized (no oversized allocation,
 * no per-feature array growth): count vertices first, then fill. The nested
 * `getCoordinates()` allocation is transient and — on the worker path — off the
 * main thread.
 */
export function decodeWkbPolygonColumnFlat(geometryColumn: Vector): FlatPolygonGeometry {
  const wkb = new WKB();
  const raw = geometryColumn.toArray() as ArrayLike<ArrayBuffer>;
  const featureCount = raw.length;

  const rings: Array<ReadonlyArray<readonly [number, number]> | null> = new Array(featureCount);
  const startIndices = new Int32Array(featureCount + 1);
  let totalVertices = 0;
  for (let i = 0; i < featureCount; i += 1) {
    const geometry = wkb.readGeometry(raw[i]) as unknown as { getCoordinates: () => unknown };
    const ring = exteriorRing(geometry.getCoordinates());
    rings[i] = ring;
    startIndices[i] = totalVertices;
    totalVertices += ring ? ring.length : 0;
  }
  startIndices[featureCount] = totalVertices;

  const positions = new Float32Array(totalVertices * 2);
  let cursor = 0;
  for (let i = 0; i < featureCount; i += 1) {
    const ring = rings[i];
    if (!ring) {
      continue;
    }
    for (let v = 0; v < ring.length; v += 1) {
      positions[cursor++] = Number(ring[v][0]);
      positions[cursor++] = Number(ring[v][1]);
    }
  }

  return { kind: 'polygon', positions, startIndices, featureCount };
}

/**
 * Decode a WKB point column into flat `xs`/`ys` (one coordinate per feature).
 * Mirrors the historical `_decodeWkbColumnFlat`: the first flat coordinate pair.
 */
export function decodeWkbPointColumnFlat(geometryColumn: Vector): FlatPointGeometry {
  const wkb = new WKB();
  const raw = geometryColumn.toArray() as ArrayLike<ArrayBuffer>;
  const featureCount = raw.length;
  const xs = new Float32Array(featureCount);
  const ys = new Float32Array(featureCount);
  for (let i = 0; i < featureCount; i += 1) {
    const flat = (
      wkb.readGeometry(raw[i]) as unknown as { getFlatCoordinates: () => Array<number | bigint> }
    ).getFlatCoordinates();
    xs[i] = Number(flat[0]);
    ys[i] = Number(flat[1]);
  }
  return { kind: 'point', xs, ys, featureCount };
}

/**
 * Decode a WKB geometry column into flat buffers, dispatched by geometry kind.
 * `circle` and `point` both decode to point coordinates (a circle is a point plus
 * a separately-loaded radius column).
 */
export function decodeShapesGeometryFlat(
  table: ArrowTable,
  columnName: string,
  geometryKind: 'polygon' | 'circle' | 'point'
): FlatShapeGeometry {
  const column = getBinaryGeometryColumn(table, columnName);
  if (!isWkbColumn(table, columnName)) {
    throw new Error('Unexpected encoding type for shapes geometry; only WKB is supported');
  }
  return geometryKind === 'polygon'
    ? decodeWkbPolygonColumnFlat(column)
    : decodeWkbPointColumnFlat(column);
}
