import type { Matrix4 } from '@math.gl/core';
import { PolygonLayer, type Layer, type PickingInfo } from 'deck.gl';
import type { SpatialShapesSublayer } from './spatialLayerProps';

export type ShapePolygon = Array<Array<[number, number]>>;

export type ShapesGeometryRepresentationKind = 'js-polygons' | 'wkb-parquet' | 'geoarrow-table';

export interface ShapesRenderDataLike {
  kind: ShapesGeometryRepresentationKind;
  elementKey: string;
  featureIds: string[];
  polygons?: ShapePolygon[];
  rowIndexByFeatureIndex: Int32Array;
  geometryTable?: GeoarrowTableLike;
  geometryColumnName?: string;
}

interface GeoarrowVectorLike {
  get(index: number): unknown;
}

export interface GeoarrowTableLike {
  numRows: number;
  getChild(name: string): GeoarrowVectorLike | null | undefined;
}

export interface ShapeFeatureStateRuntime {
  fillColorByFeatureId: Map<string, [number, number, number, number]>;
  strokeColorByFeatureId: Map<string, [number, number, number, number]>;
  hiddenFeatureIds: Set<string>;
  fadedFeatureIds: Set<string>;
  filteredOpacityMultiplier: number;
}

export interface ShapeFeatureRenderDatum {
  featureId: string;
  featureIndex: number;
  polygon: ShapePolygon;
  rowIndex?: number;
}

export interface ShapesLayerPickEvent {
  layerId: string;
  elementKey: string;
  featureId: string;
  featureIndex: number;
  coordinateSystem?: string | null;
  rowIndex?: number;
  object: ShapeFeatureRenderDatum;
  pickInfo: PickingInfo;
}

export interface ShapeTooltipRuntimeData {
  tooltipFields?: string[];
  tooltipColumns?: Array<ArrayLike<unknown> | undefined>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isShapeFeatureRenderDatum(value: unknown): value is ShapeFeatureRenderDatum {
  if (!isRecord(value)) {
    return false;
  }
  return (
    typeof value.featureId === 'string' &&
    typeof value.featureIndex === 'number' &&
    isShapePolygon(value.polygon)
  );
}

export interface CreateShapesDeckLayerOptions {
  id: string;
  visible?: boolean;
  opacity?: number;
  modelMatrix?: Matrix4;
  spatialCoordinateSystem?: string | null;
  onShapeHover?: (event: ShapesLayerPickEvent) => void;
  onShapeClick?: (event: ShapesLayerPickEvent) => void;
}

export function normalizeShapeFeatureState(
  featureState: SpatialShapesSublayer['featureState']
): ShapeFeatureStateRuntime {
  return {
    fillColorByFeatureId: new Map(Object.entries(featureState?.fillColorByFeatureId ?? {})),
    strokeColorByFeatureId: new Map(Object.entries(featureState?.strokeColorByFeatureId ?? {})),
    hiddenFeatureIds: new Set(featureState?.hiddenFeatureIds ?? []),
    fadedFeatureIds: new Set(featureState?.fadedFeatureIds ?? []),
    filteredOpacityMultiplier: featureState?.filteredOpacityMultiplier ?? 0.35,
  };
}

function multiplyAlpha(
  color: [number, number, number, number],
  multiplier: number
): [number, number, number, number] {
  return [
    color[0],
    color[1],
    color[2],
    Math.max(0, Math.min(255, Math.round(color[3] * multiplier))),
  ];
}

function buildRenderedFeatures(
  renderData: ShapesRenderDataLike,
  sublayer: SpatialShapesSublayer
): ShapeFeatureRenderDatum[] {
  const polygons = renderData.polygons ?? [];
  const count = Math.min(renderData.featureIds.length, polygons.length);
  const featureState = normalizeShapeFeatureState(sublayer.featureState);
  const features: ShapeFeatureRenderDatum[] = [];

  for (let featureIndex = 0; featureIndex < count; featureIndex++) {
    const featureId = renderData.featureIds[featureIndex];
    const polygon = polygons[featureIndex];
    if (!featureId || !polygon || featureState.hiddenFeatureIds.has(featureId)) {
      continue;
    }
    const rowIndex = renderData.rowIndexByFeatureIndex?.[featureIndex];
    features.push({
      featureId,
      featureIndex,
      polygon,
      rowIndex: rowIndex !== undefined && rowIndex >= 0 ? rowIndex : undefined,
    });
  }

  return features;
}

function isShapePolygon(value: unknown): value is ShapePolygon {
  return Array.isArray(value);
}

function buildGeoarrowRenderedFeatures(
  renderData: ShapesRenderDataLike,
  sublayer: SpatialShapesSublayer
): ShapeFeatureRenderDatum[] {
  const geometryTable = renderData.geometryTable;
  const geometryColumnName = renderData.geometryColumnName;
  if (!geometryTable || !geometryColumnName) {
    return [];
  }
  const geometryColumn = geometryTable.getChild(geometryColumnName);
  if (!geometryColumn) {
    return [];
  }
  const featureState = normalizeShapeFeatureState(sublayer.featureState);
  const count = Math.min(geometryTable.numRows, renderData.featureIds.length);
  const features: ShapeFeatureRenderDatum[] = [];

  for (let featureIndex = 0; featureIndex < count; featureIndex++) {
    const featureId = renderData.featureIds[featureIndex];
    if (!featureId || featureState.hiddenFeatureIds.has(featureId)) {
      continue;
    }
    const polygon = geometryColumn.get(featureIndex);
    if (!isShapePolygon(polygon)) {
      continue;
    }
    const rowIndex = renderData.rowIndexByFeatureIndex[featureIndex];
    features.push({
      featureId,
      featureIndex,
      polygon,
      rowIndex: rowIndex >= 0 ? rowIndex : undefined,
    });
  }

  return features;
}

function createPickHandler(
  layerId: string,
  elementKey: string,
  coordinateSystem: string | null | undefined,
  callback: ((event: ShapesLayerPickEvent) => void) | undefined
) {
  if (!callback) {
    return undefined;
  }

  return (pickInfo: PickingInfo) => {
    const object = resolveShapeFeatureFromPickInfo(pickInfo);
    if (!object?.featureId) {
      return;
    }
    callback({
      layerId,
      elementKey,
      featureId: object.featureId,
      featureIndex: object.featureIndex,
      coordinateSystem,
      rowIndex: object.rowIndex,
      object,
      pickInfo,
    });
  };
}

export function resolveShapeFeatureFromPickInfo(
  pickInfo: Pick<{ object?: unknown }, 'object'>
): ShapeFeatureRenderDatum | undefined {
  const object = pickInfo.object;
  if (!isShapeFeatureRenderDatum(object)) {
    return undefined;
  }
  return object;
}

export function resolveShapeTooltipFromPickInfo(
  renderData: ShapeTooltipRuntimeData,
  pickInfo: Pick<{ object?: unknown }, 'object'>
): { title: string; items: Array<{ label: string; value: string }> } | undefined {
  const feature = resolveShapeFeatureFromPickInfo(pickInfo);
  if (!feature) {
    return undefined;
  }
  const rowIndex = feature.rowIndex;
  if (
    rowIndex === undefined ||
    rowIndex < 0 ||
    !renderData.tooltipFields ||
    !renderData.tooltipColumns
  ) {
    return undefined;
  }

  const items = renderData.tooltipFields
    .map((field, fieldIndex) => {
      const column = renderData.tooltipColumns?.[fieldIndex];
      const value = column?.[rowIndex];
      return {
        label: field,
        value: value === null || value === undefined ? '' : String(value),
      };
    })
    .filter((item) => item.value !== '');

  if (items.length === 0) {
    return undefined;
  }

  return {
    title: feature.featureId,
    items,
  };
}

export function createShapesDeckLayer(
  renderData: ShapesRenderDataLike,
  sublayer: SpatialShapesSublayer,
  options: CreateShapesDeckLayerOptions
): Layer | null {
  if ((options.visible ?? sublayer.visible ?? true) === false) {
    return null;
  }

  const data =
    renderData.kind === 'geoarrow-table'
      ? buildGeoarrowRenderedFeatures(renderData, sublayer)
      : buildRenderedFeatures(renderData, sublayer);
  const featureState = normalizeShapeFeatureState(sublayer.featureState);
  const defaultFillColor = sublayer.defaultFillColor ?? [100, 100, 200, 180];
  const defaultStrokeColor = sublayer.defaultStrokeColor ?? [255, 255, 255, 255];
  const defaultStrokeWidth = sublayer.defaultStrokeWidth ?? 1;

  return new PolygonLayer<ShapeFeatureRenderDatum>({
    id: options.id,
    data,
    getPolygon: (d) => d.polygon,
    getFillColor: (d) => {
      const base = featureState.fillColorByFeatureId.get(d.featureId) ?? defaultFillColor;
      return featureState.fadedFeatureIds.has(d.featureId)
        ? multiplyAlpha(base, featureState.filteredOpacityMultiplier)
        : base;
    },
    getLineColor: (d) => {
      const base = featureState.strokeColorByFeatureId.get(d.featureId) ?? defaultStrokeColor;
      return featureState.fadedFeatureIds.has(d.featureId)
        ? multiplyAlpha(base, featureState.filteredOpacityMultiplier)
        : base;
    },
    getLineWidth: defaultStrokeWidth,
    lineWidthUnits: 'pixels',
    filled: true,
    stroked: true,
    opacity: options.opacity ?? 1,
    modelMatrix: options.modelMatrix,
    pickable: true,
    autoHighlight: true,
    highlightColor: [255, 255, 0, 128],
    onHover: createPickHandler(
      options.id,
      sublayer.elementKey,
      options.spatialCoordinateSystem,
      options.onShapeHover
    ),
    onClick: createPickHandler(
      options.id,
      sublayer.elementKey,
      options.spatialCoordinateSystem,
      options.onShapeClick
    ),
  });
}
