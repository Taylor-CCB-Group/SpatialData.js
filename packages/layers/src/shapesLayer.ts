import type { Matrix4 } from '@math.gl/core';
import { type Layer, type PickingInfo, PolygonLayer, ScatterplotLayer } from 'deck.gl';
import type { SpatialShapesSublayer } from './spatialLayerProps';

export type ShapePolygon = Array<Array<[number, number]>>;

export type ShapesGeometryKind = 'polygon' | 'circle' | 'point';

/** Default marker radius for point landmarks (pixels). */
export const DEFAULT_SHAPE_POINT_RADIUS_PX = 8;
export const DEFAULT_SHAPE_STROKE_WIDTH = 1;
export const DEFAULT_SHAPE_STROKE_WIDTH_UNITS = 'common' as const;
export const DEFAULT_SHAPE_STROKE_WIDTH_MIN_PIXELS = 0;
export const DEFAULT_SHAPE_STROKE_WIDTH_MAX_PIXELS = 1;

export type ShapesGeometryRepresentationKind = 'js-polygons' | 'wkb-parquet' | 'geoarrow-table';
export type ShapeStrokeWidthUnits = 'common' | 'pixels';

export interface ShapeCircleColumnarLike {
  positions: [Float32Array, Float32Array];
  radii?: Float32Array;
}

export interface ShapesRenderDataLike {
  kind: ShapesGeometryRepresentationKind;
  geometryKind?: ShapesGeometryKind;
  elementKey: string;
  featureIds: string[];
  polygons?: ShapePolygon[];
  circles?: ShapeCircleColumnarLike;
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

export interface ShapePolygonRenderDatum {
  featureId: string;
  featureIndex: number;
  polygon: ShapePolygon;
  rowIndex?: number;
}

export interface ShapeCircleRenderDatum {
  featureId: string;
  featureIndex: number;
  position: [number, number];
  radius: number;
  rowIndex?: number;
}

export type ShapeFeatureRenderDatum = ShapePolygonRenderDatum | ShapeCircleRenderDatum;

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

/**
 * Pre-built deck.gl data arrays for a shapes layer.
 *
 * These are computed once after geometry loads (and after each `hiddenFeatureIds` change)
 * and stored in the load cache. `createShapesDeckLayer` uses them directly when provided,
 * avoiding the O(n-features) allocation on every `getLayers()` call.
 */
export interface ShapesPrebuiltData {
  geometryKind: ShapesGeometryKind;
  data: ShapePolygonRenderDatum[] | ShapeCircleRenderDatum[];
}

/** Cache normalised featureState runtimes by object identity. */
const normalizeCache = new WeakMap<object, ShapeFeatureStateRuntime>();

/** Singleton for the common case of no featureState at all. */
const EMPTY_FEATURE_STATE_RUNTIME = Object.freeze({
  fillColorByFeatureId: new Map(),
  strokeColorByFeatureId: new Map(),
  hiddenFeatureIds: new Set(),
  fadedFeatureIds: new Set(),
  filteredOpacityMultiplier: 0.35,
} satisfies ShapeFeatureStateRuntime);

export function normalizeShapeFeatureState(
  featureState: SpatialShapesSublayer['featureState']
): ShapeFeatureStateRuntime {
  if (!featureState) return EMPTY_FEATURE_STATE_RUNTIME;
  const cached = normalizeCache.get(featureState);
  if (cached) return cached;
  const result: ShapeFeatureStateRuntime = {
    fillColorByFeatureId: new Map(Object.entries(featureState.fillColorByFeatureId ?? {})),
    strokeColorByFeatureId: new Map(Object.entries(featureState.strokeColorByFeatureId ?? {})),
    hiddenFeatureIds: new Set(featureState.hiddenFeatureIds ?? []),
    fadedFeatureIds: new Set(featureState.fadedFeatureIds ?? []),
    filteredOpacityMultiplier: featureState.filteredOpacityMultiplier ?? 0.35,
  };
  normalizeCache.set(featureState, result);
  return result;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isShapePolygon(value: unknown): value is ShapePolygon {
  return Array.isArray(value);
}

function isShapePolygonRenderDatum(value: unknown): value is ShapePolygonRenderDatum {
  if (!isRecord(value)) {
    return false;
  }
  return (
    typeof value.featureId === 'string' &&
    typeof value.featureIndex === 'number' &&
    isShapePolygon(value.polygon)
  );
}

function isShapeCircleRenderDatum(value: unknown): value is ShapeCircleRenderDatum {
  if (!isRecord(value)) {
    return false;
  }
  const position = value.position;
  return (
    typeof value.featureId === 'string' &&
    typeof value.featureIndex === 'number' &&
    typeof value.radius === 'number' &&
    Array.isArray(position) &&
    position.length >= 2 &&
    typeof position[0] === 'number' &&
    typeof position[1] === 'number'
  );
}

function isShapeFeatureRenderDatum(value: unknown): value is ShapeFeatureRenderDatum {
  return isShapePolygonRenderDatum(value) || isShapeCircleRenderDatum(value);
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

function resolveFeatureColor(
  featureId: string,
  primaryColors: Map<string, [number, number, number, number]>,
  fallbackColors: Map<string, [number, number, number, number]>,
  defaultColor: [number, number, number, number],
  featureState: ShapeFeatureStateRuntime
): [number, number, number, number] {
  const base = primaryColors.get(featureId) ?? fallbackColors.get(featureId) ?? defaultColor;
  return featureState.fadedFeatureIds.has(featureId)
    ? multiplyAlpha(base, featureState.filteredOpacityMultiplier)
    : base;
}

function resolveGeometryKind(renderData: ShapesRenderDataLike): ShapesGeometryKind {
  if (renderData.geometryKind) {
    return renderData.geometryKind;
  }
  if (renderData.circles) {
    return renderData.circles.radii !== undefined ? 'circle' : 'point';
  }
  return 'polygon';
}

function buildPolygonRenderedFeatures(
  renderData: ShapesRenderDataLike,
  hiddenFeatureIds: Set<string>
): ShapePolygonRenderDatum[] {
  const polygons = renderData.polygons ?? [];
  const count = Math.min(renderData.featureIds.length, polygons.length);
  const features: ShapePolygonRenderDatum[] = [];

  for (let featureIndex = 0; featureIndex < count; featureIndex++) {
    const featureId = renderData.featureIds[featureIndex];
    const polygon = polygons[featureIndex];
    if (!featureId || !polygon || hiddenFeatureIds.has(featureId)) {
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

function buildCircleRenderedFeatures(
  renderData: ShapesRenderDataLike,
  hiddenFeatureIds: Set<string>
): ShapeCircleRenderDatum[] {
  const circles = renderData.circles;
  if (!circles) {
    return [];
  }
  const [xs, ys] = circles.positions;
  const radii = circles.radii;
  const usePerFeatureRadius = radii !== undefined;
  const count = Math.min(
    renderData.featureIds.length,
    xs.length,
    ys.length,
    usePerFeatureRadius ? radii.length : xs.length
  );
  const features: ShapeCircleRenderDatum[] = [];

  for (let featureIndex = 0; featureIndex < count; featureIndex++) {
    const featureId = renderData.featureIds[featureIndex];
    if (!featureId || hiddenFeatureIds.has(featureId)) {
      continue;
    }
    const x = xs[featureIndex];
    const y = ys[featureIndex];
    const radius = usePerFeatureRadius ? radii[featureIndex] : DEFAULT_SHAPE_POINT_RADIUS_PX;
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(radius) || radius < 0) {
      continue;
    }
    const rowIndex = renderData.rowIndexByFeatureIndex?.[featureIndex];
    features.push({
      featureId,
      featureIndex,
      position: [x, y],
      radius,
      rowIndex: rowIndex !== undefined && rowIndex >= 0 ? rowIndex : undefined,
    });
  }

  return features;
}

function buildGeoarrowRenderedFeatures(
  renderData: ShapesRenderDataLike,
  hiddenFeatureIds: Set<string>
): ShapePolygonRenderDatum[] {
  const geometryTable = renderData.geometryTable;
  const geometryColumnName = renderData.geometryColumnName;
  if (!geometryTable || !geometryColumnName) {
    return [];
  }
  const geometryColumn = geometryTable.getChild(geometryColumnName);
  if (!geometryColumn) {
    return [];
  }
  const count = Math.min(geometryTable.numRows, renderData.featureIds.length);
  const features: ShapePolygonRenderDatum[] = [];

  for (let featureIndex = 0; featureIndex < count; featureIndex++) {
    const featureId = renderData.featureIds[featureIndex];
    if (!featureId || hiddenFeatureIds.has(featureId)) {
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

/**
 * Pre-build the deck.gl `data` array for a shapes layer.
 *
 * Call this once after geometry loads and after each `hiddenFeatureIds` change,
 * then pass the result to `createShapesDeckLayer` via the `prebuilt` parameter.
 * This keeps the O(n-features) allocation out of the per-frame render path.
 */
export function buildShapesPrebuiltData(
  renderData: ShapesRenderDataLike,
  hiddenFeatureIds?: string[]
): ShapesPrebuiltData {
  const geometryKind = resolveGeometryKind(renderData);
  const hiddenSet = new Set(hiddenFeatureIds ?? []);

  if (geometryKind === 'circle' || geometryKind === 'point') {
    return { geometryKind, data: buildCircleRenderedFeatures(renderData, hiddenSet) };
  }

  const data =
    renderData.kind === 'geoarrow-table'
      ? buildGeoarrowRenderedFeatures(renderData, hiddenSet)
      : buildPolygonRenderedFeatures(renderData, hiddenSet);

  return { geometryKind: 'polygon', data };
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

export interface ShapeTooltipRowIndexAlignment {
  tooltipRowIndexByFeatureId?: Map<string, number>;
  tooltipRowIndices?: Int32Array;
  rowIndexByFeatureIndex?: Int32Array;
}

export function resolveShapeTooltipRowIndex(
  feature: ShapeFeatureRenderDatum,
  alignment?: ShapeTooltipRowIndexAlignment
): number | undefined {
  const fromFeatureId = alignment?.tooltipRowIndexByFeatureId?.get(feature.featureId);
  const fromFeatureRowIndex =
    feature.rowIndex !== undefined && feature.rowIndex >= 0 ? feature.rowIndex : undefined;
  const fromTooltip = alignment?.tooltipRowIndices?.[feature.featureIndex];
  const fromRender = alignment?.rowIndexByFeatureIndex?.[feature.featureIndex];

  if (fromFeatureRowIndex !== undefined) {
    return fromFeatureRowIndex;
  }

  if (fromTooltip !== undefined && fromTooltip >= 0) {
    return fromTooltip;
  }

  if (fromRender !== undefined && fromRender >= 0) {
    return fromRender;
  }

  if (fromFeatureId !== undefined && fromFeatureId >= 0) {
    return fromFeatureId;
  }

  return undefined;
}

export function resolveShapeFeatureFromPick(
  pickInfo: Pick<{ index?: number; object?: unknown }, 'index' | 'object'>,
  prebuilt?: ShapesPrebuiltData
): ShapeFeatureRenderDatum | undefined {
  const fromObject = resolveShapeFeatureFromPickInfo(pickInfo);
  if (fromObject) {
    return fromObject;
  }
  if (!prebuilt || typeof pickInfo.index !== 'number' || pickInfo.index < 0) {
    return undefined;
  }
  const datum = prebuilt.data[pickInfo.index];
  return isShapeFeatureRenderDatum(datum) ? datum : undefined;
}

export function resolveShapeTooltipFromPickInfo(
  renderData: ShapeTooltipRuntimeData,
  pickInfo: Pick<{ index?: number; object?: unknown }, 'index' | 'object'>,
  alignment?: ShapeTooltipRowIndexAlignment,
  prebuilt?: ShapesPrebuiltData
): { title: string; items: Array<{ label: string; value: string }> } | undefined {
  const feature = resolveShapeFeatureFromPick(pickInfo, prebuilt);
  if (!feature) {
    return undefined;
  }
  const rowIndex = resolveShapeTooltipRowIndex(feature, alignment);
  if (!renderData.tooltipFields || !renderData.tooltipColumns) {
    return undefined;
  }
  if (rowIndex === undefined || rowIndex < 0) {
    return {
      title: feature.featureId,
      items: [
        { label: 'feature_id', value: feature.featureId },
        { label: 'feature_index', value: String(feature.featureIndex) },
        {
          label: 'table_row',
          value: 'unmatched — shape index was not found in the associated table instance_key column',
        },
      ],
    };
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
    return {
      title: feature.featureId,
      items: [
        { label: 'feature_id', value: feature.featureId },
        { label: 'table_row', value: String(rowIndex) },
        {
          label: 'tooltip',
          value: 'matched table row has no non-empty values for the selected tooltip fields',
        },
      ],
    };
  }

  return {
    title: feature.featureId,
    items,
  };
}

function createPolygonDeckLayer(
  data: ShapePolygonRenderDatum[],
  sublayer: SpatialShapesSublayer,
  options: CreateShapesDeckLayerOptions
): Layer {
  const featureState = normalizeShapeFeatureState(sublayer.featureState);
  const defaultFillColor = sublayer.defaultFillColor ?? [100, 100, 200, 180];
  const defaultStrokeColor = sublayer.defaultStrokeColor ?? defaultFillColor;
  const defaultStrokeWidth = sublayer.defaultStrokeWidth ?? DEFAULT_SHAPE_STROKE_WIDTH;
  const defaultStrokeWidthUnits =
    sublayer.defaultStrokeWidthUnits ?? DEFAULT_SHAPE_STROKE_WIDTH_UNITS;
  const defaultStrokeWidthMinPixels =
    sublayer.defaultStrokeWidthMinPixels ?? DEFAULT_SHAPE_STROKE_WIDTH_MIN_PIXELS;
  const defaultStrokeWidthMaxPixels =
    sublayer.defaultStrokeWidthMaxPixels ?? DEFAULT_SHAPE_STROKE_WIDTH_MAX_PIXELS;

  return new PolygonLayer<ShapePolygonRenderDatum>({
    id: options.id,
    data,
    getPolygon: (d) => d.polygon,
    getFillColor: (d) =>
      resolveFeatureColor(
        d.featureId,
        featureState.fillColorByFeatureId,
        EMPTY_FEATURE_STATE_RUNTIME.fillColorByFeatureId,
        defaultFillColor,
        featureState
      ),
    getLineColor: (d) =>
      resolveFeatureColor(
        d.featureId,
        featureState.strokeColorByFeatureId,
        featureState.fillColorByFeatureId,
        defaultStrokeColor,
        featureState
      ),
    getLineWidth: defaultStrokeWidth,
    lineWidthUnits: defaultStrokeWidthUnits,
    lineWidthMinPixels: defaultStrokeWidthMinPixels,
    lineWidthMaxPixels: defaultStrokeWidthMaxPixels,
    updateTriggers: {
      getFillColor: [featureState, defaultFillColor],
      getLineColor: [featureState, defaultStrokeColor],
      getLineWidth: [defaultStrokeWidth],
    },
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

function createCircleDeckLayer(
  data: ShapeCircleRenderDatum[],
  geometryKind: 'circle' | 'point',
  sublayer: SpatialShapesSublayer,
  options: CreateShapesDeckLayerOptions
): Layer {
  const featureState = normalizeShapeFeatureState(sublayer.featureState);
  const defaultFillColor = sublayer.defaultFillColor ?? [100, 100, 200, 180];
  const radiusUnits = geometryKind === 'point' ? 'pixels' : 'common';

  return new ScatterplotLayer<ShapeCircleRenderDatum>({
    id: options.id,
    data,
    getPosition: (d) => d.position,
    getRadius: (d) => d.radius,
    radiusUnits,
    getFillColor: (d) => {
      const base = featureState.fillColorByFeatureId.get(d.featureId) ?? defaultFillColor;
      return featureState.fadedFeatureIds.has(d.featureId)
        ? multiplyAlpha(base, featureState.filteredOpacityMultiplier)
        : base;
    },
    updateTriggers: {
      getFillColor: [featureState, defaultFillColor],
    },
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

/**
 * Create a deck.gl layer for shapes data.
 *
 * When `prebuilt` is provided the function acts as a pure descriptor assembler:
 * it skips all O(n-features) data construction and just creates the layer with
 * the stable pre-built `data` reference.  Pass `prebuilt` from the load-path
 * cache (`buildShapesPrebuiltData`) to keep the per-frame render path free of
 * allocations.
 *
 * Without `prebuilt` the function falls back to building the data inline, which
 * preserves backward compatibility for external callers and tests.
 */
export function createShapesDeckLayer(
  renderData: ShapesRenderDataLike,
  sublayer: SpatialShapesSublayer,
  options: CreateShapesDeckLayerOptions,
  prebuilt?: ShapesPrebuiltData
): Layer | null {
  if ((options.visible ?? sublayer.visible ?? true) === false) {
    return null;
  }

  if (prebuilt) {
    if (prebuilt.data.length === 0) return null;
    if (prebuilt.geometryKind === 'circle' || prebuilt.geometryKind === 'point') {
      return createCircleDeckLayer(
        prebuilt.data as ShapeCircleRenderDatum[],
        prebuilt.geometryKind,
        sublayer,
        options
      );
    }
    return createPolygonDeckLayer(prebuilt.data as ShapePolygonRenderDatum[], sublayer, options);
  }

  // Fallback: build data inline (backward-compatible path for external callers).
  const geometryKind = resolveGeometryKind(renderData);
  const featureState = normalizeShapeFeatureState(sublayer.featureState);

  if (geometryKind === 'circle' || geometryKind === 'point') {
    const data = buildCircleRenderedFeatures(renderData, featureState.hiddenFeatureIds);
    if (data.length === 0) {
      return null;
    }
    return createCircleDeckLayer(data, geometryKind, sublayer, options);
  }

  const data =
    renderData.kind === 'geoarrow-table'
      ? buildGeoarrowRenderedFeatures(renderData, featureState.hiddenFeatureIds)
      : buildPolygonRenderedFeatures(renderData, featureState.hiddenFeatureIds);
  if (data.length === 0) {
    return null;
  }
  return createPolygonDeckLayer(data, sublayer, options);
}
