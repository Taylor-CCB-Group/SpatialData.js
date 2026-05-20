import type { Table as ArrowTable } from 'apache-arrow';

export type ShapePolygon = Array<Array<[number, number]>>;

export type ShapesGeometryRepresentationKind = 'js-polygons' | 'wkb-parquet' | 'geoarrow-table';

export interface ShapesRenderData {
  kind: ShapesGeometryRepresentationKind;
  elementKey: string;
  featureIds: string[];
  polygons?: ShapePolygon[];
  geometryTable?: ArrowTable;
  geometryColumnName?: string;
  rowIndexByFeatureIndex: Int32Array;
}
