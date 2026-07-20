import type { Table as ArrowTable } from 'apache-arrow';
import type { TessellatedPolygons } from './shapesPolygonTessellate.js';

export type ShapePolygon = Array<Array<[number, number]>>;

export type ShapesGeometryKind = 'polygon' | 'circle' | 'point';

/** Columnar point/circle centers (xs, ys). Radii are required for `circle`, omitted for `point`. */
export interface ShapeCircleColumnar {
  positions: [Float32Array, Float32Array];
  radii?: Float32Array;
}

export type ShapesGeometryRepresentationKind =
  | 'js-polygons'
  | 'flat-polygons'
  | 'wkb-parquet'
  | 'geoarrow-table';

/**
 * Flat GeoArrow-style polygon geometry: interleaved exterior-ring coordinates plus
 * per-feature vertex offsets. This is the transferable representation the worker
 * produces and a binary deck.gl `PolygonLayer` consumes directly — no per-vertex
 * JS object. Preferred over {@link ShapesRenderData.polygons} when present.
 */
export interface FlatPolygonGeometry {
  /** Interleaved `[x0, y0, x1, y1, …]` exterior-ring coordinates for all features. */
  positions: Float32Array;
  /** Vertex offset where each feature begins; length `featureCount + 1`. */
  startIndices: Int32Array;
  /** Vertex-pulling render topology, tessellated off the main thread by the geometry
   *  worker. Present on the worker path; absent on the main-thread decode path, where
   *  the renderer tessellates lazily from `positions`/`startIndices`. */
  tessellation?: TessellatedPolygons;
}

export interface ShapesRenderData {
  kind: ShapesGeometryRepresentationKind;
  /** Geometry semantics within the representation (e.g. Xenium cell_circles). */
  geometryKind: ShapesGeometryKind;
  elementKey: string;
  featureIds: string[];
  /** Legacy nested polygons (main-thread decode / compat). Prefer `polygonBinary`. */
  polygons?: ShapePolygon[];
  /** Transferable flat polygon geometry. Set by the off-thread decode path. */
  polygonBinary?: FlatPolygonGeometry;
  circles?: ShapeCircleColumnar;
  geometryTable?: ArrowTable;
  geometryColumnName?: string;
  rowIndexByFeatureIndex: Int32Array;
}
