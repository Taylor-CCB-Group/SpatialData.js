import type { Table as ArrowTable } from 'apache-arrow';

export type ShapePolygon = Array<Array<[number, number]>>;

export type ShapesGeometryKind = 'polygon' | 'circle' | 'point';

/** Columnar point/circle centers (xs, ys). Radii are required for `circle`, omitted for `point`. */
export interface ShapeCircleColumnar {
  positions: [Float32Array, Float32Array];
  radii?: Float32Array;
}

export type ShapesGeometryRepresentationKind = 'js-polygons' | 'wkb-parquet' | 'geoarrow-table';

export interface ShapesRenderData {
  kind: ShapesGeometryRepresentationKind;
  /** Geometry semantics within the representation (e.g. Xenium cell_circles). */
  geometryKind: ShapesGeometryKind;
  elementKey: string;
  featureIds: string[];
  polygons?: ShapePolygon[];
  circles?: ShapeCircleColumnar;
  geometryTable?: ArrowTable;
  geometryColumnName?: string;
  rowIndexByFeatureIndex: Int32Array;
}
