// Worker-safe WKB → flat-buffer shape geometry decode.
//
// This is the CPU-heavy half of shapes loading — the WKB parse — factored out of
// `VShapesSource` so it can run *either* on the main thread (fallback) or inside
// the parquet worker. It depends only on `apache-arrow` + `ol/format/WKB`, never on
// zarrita/the store, so it is safe to import into the worker bundle.
//
// It produces **flat GeoArrow-style typed arrays** (interleaved coordinates +
// vertex offsets) rather than the historical `Array<Array<[number, number]>>`.
// Flat buffers are transferable across the worker boundary zero-copy and feed a
// binary deck.gl `PolygonLayer` directly — no per-vertex JS object ever exists.

import type { Table as ArrowTable } from 'apache-arrow';
import type { Vector } from 'apache-arrow/vector';
import WKB from 'ol/format/WKB.js';
import MultiPolygon from 'ol/geom/MultiPolygon.js';
import Polygon from 'ol/geom/Polygon.js';
import type { PolygonPartOffsets, TessellatedPolygons } from './shapesPolygonTessellate.js';

export interface FlatPolygonGeometry {
  kind: 'polygon';
  /** Interleaved coordinates `[x0, y0, x1, y1, …]` of every ring of every feature. */
  positions: Float32Array;
  /**
   * Vertex offset where each feature's rings begin; length `featureCount + 1`,
   * last entry = total vertex count.
   */
  startIndices: Int32Array;
  /** Part/hole structure of `positions`. */
  parts: PolygonPartOffsets;
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
 * The flat XY coordinates and ring ends of a decoded WKB geometry, as polygon parts.
 * Polygon → one part; MultiPolygon → one per sub-polygon. Anything else → no parts,
 * so stray geometry becomes an empty feature rather than a throw.
 */
function polygonParts(geometry: unknown): { flat: number[]; stride: number; endss: number[][] } {
  if (geometry instanceof Polygon) {
    return {
      flat: geometry.getFlatCoordinates(),
      stride: geometry.getStride(),
      endss: [geometry.getEnds()],
    };
  }
  if (geometry instanceof MultiPolygon) {
    return {
      flat: geometry.getFlatCoordinates(),
      stride: geometry.getStride(),
      endss: geometry.getEndss(),
    };
  }
  return { flat: [], stride: 2, endss: [] };
}

/**
 * Decode a WKB polygon column into flat ring positions, per-feature `startIndices`,
 * and GeoArrow MultiPolygon offsets (every part and hole kept).
 *
 * Two passes so the output buffers are exactly sized: count first, then fill.
 */
export function decodeWkbPolygonColumnFlat(geometryColumn: Vector): FlatPolygonGeometry {
  const wkb = new WKB();
  const raw = geometryColumn.toArray() as ArrayLike<ArrayBuffer>;
  const featureCount = raw.length;

  const decoded: ReturnType<typeof polygonParts>[] = new Array(featureCount);
  let polygonCount = 0;
  let ringCount = 0;
  let vertexCount = 0;
  for (let i = 0; i < featureCount; i += 1) {
    const parts = polygonParts(wkb.readGeometry(raw[i]));
    decoded[i] = parts;
    polygonCount += parts.endss.length;
    for (const ends of parts.endss) {
      ringCount += ends.length;
    }
    vertexCount += parts.flat.length / parts.stride;
  }

  const positions = new Float32Array(vertexCount * 2);
  const startIndices = new Int32Array(featureCount + 1);
  const geometryOffsets = new Int32Array(featureCount + 1);
  const polygonOffsets = new Int32Array(polygonCount + 1);
  const ringOffsets = new Int32Array(ringCount + 1);
  let p = 0;
  let r = 0;
  let v = 0;
  for (let i = 0; i < featureCount; i += 1) {
    const { flat, stride, endss } = decoded[i];
    startIndices[i] = v;
    geometryOffsets[i] = p;
    let offset = 0;
    for (const ends of endss) {
      polygonOffsets[p++] = r;
      for (const end of ends) {
        ringOffsets[r++] = v;
        for (; offset < end; offset += stride) {
          positions[v * 2] = flat[offset];
          positions[v * 2 + 1] = flat[offset + 1];
          v += 1;
        }
      }
    }
  }
  startIndices[featureCount] = v;
  geometryOffsets[featureCount] = p;
  polygonOffsets[polygonCount] = r;
  ringOffsets[ringCount] = v;

  return {
    kind: 'polygon',
    positions,
    startIndices,
    parts: { geometryOffsets, polygonOffsets, ringOffsets },
    featureCount,
  };
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
