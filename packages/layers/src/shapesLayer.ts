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
  rowIndexByFeatureIndex?: Int32Array;
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
    const object = pickInfo.object as ShapeFeatureRenderDatum | undefined;
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

export function createShapesDeckLayer(
  renderData: ShapesRenderDataLike,
  sublayer: SpatialShapesSublayer,
  options: CreateShapesDeckLayerOptions
): Layer | null {
  if ((options.visible ?? sublayer.visible ?? true) === false) {
    return null;
  }

  if (renderData.kind === 'geoarrow-table') {
    return null;
  }

  const data = buildRenderedFeatures(renderData, sublayer);
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
