import type { Matrix4 } from '@math.gl/core';
import {
  type SpatialShapesSublayer,
  type TessellatedPolygons,
  tessellateFlatPolygons,
} from '@spatialdata/core';
import { type Layer, type PickingInfo, PolygonLayer, ScatterplotLayer } from 'deck.gl';
import { FlatPolygonLayer } from './FlatPolygonLayer';

export type ShapePolygon = Array<Array<[number, number]>>;

export type ShapesGeometryKind = 'polygon' | 'circle' | 'point';

/**
 * Default shape fill colour. A **single stable reference** on purpose: it feeds
 * `updateTriggers.getFillColor`, which deck compares shallowly. A fresh
 * `[100,100,200,180]` literal per render (e.g. a default parameter) reads as a
 * changed trigger and forces deck to rebuild the entire per-feature colour
 * attribute every frame — an O(vertices) main-thread stall on every hover/pan.
 */
export const DEFAULT_SHAPE_FILL_COLOR: [number, number, number, number] = [100, 100, 200, 180];

/** Default marker radius for point landmarks (pixels). */
export const DEFAULT_SHAPE_POINT_RADIUS_PX = 8;
export const DEFAULT_SHAPE_STROKE_WIDTH = 1;
export const DEFAULT_SHAPE_STROKE_WIDTH_UNITS = 'common' as const;
export const DEFAULT_SHAPE_STROKE_WIDTH_MIN_PIXELS = 0;
export const DEFAULT_SHAPE_STROKE_WIDTH_MAX_PIXELS = 1;

export type ShapesGeometryRepresentationKind =
  | 'js-polygons'
  | 'flat-polygons'
  | 'wkb-parquet'
  | 'geoarrow-table';
export type ShapeStrokeWidthUnits = 'common' | 'pixels';

export interface ShapeCircleColumnarLike {
  positions: [Float32Array, Float32Array];
  radii?: Float32Array;
}

/** Flat GeoArrow-style polygon geometry (interleaved positions + vertex offsets). */
export interface FlatPolygonGeometryLike {
  positions: Float32Array;
  startIndices: Int32Array;
  /** Off-thread-tessellated render topology (worker path); absent → tessellate lazily. */
  tessellation?: TessellatedPolygons;
}

export interface ShapesRenderDataLike {
  kind: ShapesGeometryRepresentationKind;
  geometryKind?: ShapesGeometryKind;
  elementKey: string;
  featureIds: string[];
  polygons?: ShapePolygon[];
  /** Transferable flat polygon geometry. Rendered via a binary `PolygonLayer`. */
  polygonBinary?: FlatPolygonGeometryLike;
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

export type ShapeFeatureStateInput =
  | SpatialShapesSublayer['featureState']
  | ShapeFeatureStateRuntime;

export type SpatialShapesRuntimeSublayer = Omit<SpatialShapesSublayer, 'featureState'> & {
  featureState?: ShapeFeatureStateInput;
};

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
/**
 * Binary polygon geometry ready for a deck.gl binary `PolygonLayer`: the flat
 * coordinate + offset buffers plus the per-index feature identity needed to drive
 * colour and picking without a per-feature JS object. `featureIds[i]` /
 * `rowIndexByFeatureIndex[i]` name feature `i`, which is exactly the binary
 * polygon at `startIndices[i]`.
 */
export interface ShapesBinaryPolygonData {
  positions: Float32Array;
  startIndices: Int32Array;
  featureIds: string[];
  rowIndexByFeatureIndex?: Int32Array;
  /** Off-thread-tessellated render topology; when absent the layer tessellates lazily. */
  tessellation?: TessellatedPolygons;
}

export interface ShapesPrebuiltData {
  geometryKind: ShapesGeometryKind;
  /** Per-feature descriptors (circle/point, or the legacy nested-polygon path). */
  data: ShapePolygonRenderDatum[] | ShapeCircleRenderDatum[];
  /**
   * Present for `flat-polygons` geometry. When set, `data` is empty and the layer
   * renders from these binary buffers, resolving features by index.
   */
  binary?: ShapesBinaryPolygonData;
}

/** Cache normalised featureState runtimes by plain-object identity. */
const normalizeCache = new WeakMap<object, ShapeFeatureStateRuntime>();

/** Singleton for the common case of no featureState at all. */
export const EMPTY_SHAPE_FEATURE_STATE_RUNTIME = Object.freeze({
  fillColorByFeatureId: new Map(),
  strokeColorByFeatureId: new Map(),
  hiddenFeatureIds: new Set(),
  fadedFeatureIds: new Set(),
  filteredOpacityMultiplier: 0.35,
} satisfies ShapeFeatureStateRuntime);

export function isShapeFeatureStateRuntime(value: unknown): value is ShapeFeatureStateRuntime {
  if (!isRecord(value)) {
    return false;
  }
  return (
    value.fillColorByFeatureId instanceof Map &&
    value.strokeColorByFeatureId instanceof Map &&
    value.hiddenFeatureIds instanceof Set &&
    value.fadedFeatureIds instanceof Set &&
    typeof value.filteredOpacityMultiplier === 'number'
  );
}

function recordToRgbaMap(
  record: Record<string, [number, number, number, number]> | undefined
): Map<string, [number, number, number, number]> {
  if (!record) {
    return new Map();
  }
  const map = new Map<string, [number, number, number, number]>();
  for (const key in record) {
    if (Object.hasOwn(record, key)) {
      map.set(key, record[key]);
    }
  }
  return map;
}

/**
 * Build the Map/Set runtime used by deck accessors. Call once when feature-state
 * content changes (filtering, table-driven colours), not on cosmetic prop churn.
 */
export function buildShapeFeatureStateRuntime(
  featureState: NonNullable<ShapeFeatureStateInput>
): ShapeFeatureStateRuntime {
  if (isShapeFeatureStateRuntime(featureState)) {
    return featureState;
  }
  const cached = normalizeCache.get(featureState);
  if (cached) {
    return cached;
  }
  const result: ShapeFeatureStateRuntime = {
    fillColorByFeatureId: recordToRgbaMap(featureState.fillColorByFeatureId),
    strokeColorByFeatureId: recordToRgbaMap(featureState.strokeColorByFeatureId),
    hiddenFeatureIds: new Set(featureState.hiddenFeatureIds ?? []),
    fadedFeatureIds: new Set(featureState.fadedFeatureIds ?? []),
    filteredOpacityMultiplier: featureState.filteredOpacityMultiplier ?? 0.35,
  };
  normalizeCache.set(featureState, result);
  return result;
}

export function normalizeShapeFeatureState(
  featureState: ShapeFeatureStateInput
): ShapeFeatureStateRuntime {
  if (!featureState) {
    return EMPTY_SHAPE_FEATURE_STATE_RUNTIME;
  }
  return buildShapeFeatureStateRuntime(featureState);
}

function shapeFeatureColorUpdateTriggers(
  featureState: ShapeFeatureStateRuntime,
  defaultColor: [number, number, number, number]
) {
  return [
    featureState.fillColorByFeatureId,
    featureState.strokeColorByFeatureId,
    featureState.fadedFeatureIds,
    featureState.filteredOpacityMultiplier,
    defaultColor,
  ];
}

/**
 * The fill-colour `updateTrigger` array with a **stable identity** while its
 * contents are unchanged, memoised on the (stable) feature-state runtime.
 *
 * This is the fix for the interaction/hover buffer thrash: `createShapesDeckLayer`
 * runs on every `getLayers()` (a hover re-renders for the tooltip), and a fresh
 * trigger array each time reads to deck as "the colours changed", so it rebuilds
 * the whole per-feature colour attribute — millions of `getFillColor` calls, a
 * multi-hundred-ms main-thread stall — on every render. Feeding a stable identity
 * lets deck skip the rebuild unless feature-state actually changes.
 */
// Two levels so fill and stroke (same runtime, different default colours) each get
// a stable trigger. Both keys are stable references — the runtime from the vis-side
// feature-state cache, the default colour a module constant / config value — so a
// steady state yields a cache hit and deck skips the rebuild.
const colorTriggerCache = new WeakMap<
  ShapeFeatureStateRuntime,
  WeakMap<object, readonly unknown[]>
>();

function stableColorUpdateTrigger(
  featureState: ShapeFeatureStateRuntime,
  defaultColor: [number, number, number, number]
): readonly unknown[] {
  let byColor = colorTriggerCache.get(featureState);
  if (!byColor) {
    byColor = new WeakMap();
    colorTriggerCache.set(featureState, byColor);
  }
  const key = defaultColor as unknown as object;
  let trigger = byColor.get(key);
  if (!trigger) {
    // The runtime already changes identity on ANY feature-state change — the
    // vis-side cache keys it by a signature that includes hidden/faded/colours —
    // so `featureState` (the memo key) is a complete invalidation signal; the
    // trigger contents need only be stable-per-runtime.
    trigger = shapeFeatureColorUpdateTriggers(featureState, defaultColor);
    byColor.set(key, trigger);
  }
  return trigger;
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
  /**
   * When false, the layer is rendered non-pickable with autoHighlight disabled.
   * Used to suppress deck.gl's per-pointer-move picking-buffer render over large
   * shape geometry while the camera is being panned/zoomed. Defaults to true.
   */
  pickingEnabled?: boolean;
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

/**
 * How far the outline is lifted toward white, and how much its alpha is raised,
 * relative to the fill it is derived from.
 */
const STROKE_LIGHTEN = 0.45;
const STROKE_ALPHA_LIFT = 55;

/**
 * Memoise the derivation on the **input array identity**. A stable fill (a module
 * default, or the caller's stable per-feature colour array) must yield a stable
 * outline array, so the outline's `updateTrigger` keeps a stable identity and deck
 * does not rebuild the outline colour buffer on every hover/pan — the same
 * buffer-thrash fix the fill relies on.
 */
const derivedStrokeCache = new WeakMap<object, [number, number, number, number]>();

/**
 * Derive a shape's outline colour from its **fill**. The fill is the *specified*
 * colour (a layer default or a data-column encoding); the outline is a lighter,
 * slightly more opaque accent of it, so adjacent shapes read as distinct without
 * the edge competing with the fill. A ≤1px outline the *same* colour as the fill
 * is invisible — the reason shapes previously did not read as shapes. A genuine
 * per-feature stroke override still wins over this derivation (see
 * `resolveStrokeColor`).
 */
export function deriveStrokeColor(
  fill: [number, number, number, number]
): [number, number, number, number] {
  const key = fill as unknown as object;
  const cached = derivedStrokeCache.get(key);
  if (cached) {
    return cached;
  }
  const lift = (channel: number): number => Math.round(channel + (255 - channel) * STROKE_LIGHTEN);
  const result: [number, number, number, number] = [
    lift(fill[0]),
    lift(fill[1]),
    lift(fill[2]),
    Math.min(255, fill[3] + STROKE_ALPHA_LIFT),
  ];
  derivedStrokeCache.set(key, result);
  return result;
}

/**
 * Resolve a feature's outline colour. Precedence: an explicit per-feature stroke
 * override, else a lighter derivation of the feature's resolved fill (per-feature
 * fill colour when present, otherwise the caller's default outline). Fade is
 * applied last, mirroring `resolveFeatureColor`.
 */
function resolveStrokeColor(
  featureId: string,
  featureState: ShapeFeatureStateRuntime,
  resolvedDefaultStroke: [number, number, number, number]
): [number, number, number, number] {
  const explicit = featureState.strokeColorByFeatureId.get(featureId);
  const fill = featureState.fillColorByFeatureId.get(featureId);
  const base = explicit ?? (fill ? deriveStrokeColor(fill) : resolvedDefaultStroke);
  return featureState.fadedFeatureIds.has(featureId)
    ? multiplyAlpha(base, featureState.filteredOpacityMultiplier)
    : base;
}

/** Hidden features are not excluded from a binary buffer (that would misalign the
 *  index); they render fully transparent instead. */
const TRANSPARENT_RGBA: [number, number, number, number] = [0, 0, 0, 0];

/**
 * The tessellation pipeline for the binary polygon path. Each stage is memoised on
 * its stable upstream input so `createShapesDeckLayer` (which runs every
 * `getLayers()`) does no per-frame work and hands deck stable buffer identities —
 * the same discipline the old binary descriptors used, extended to the fill +
 * fwidth-outline geometry.
 */

/** Shared ring positions + per-triangle topology for vertex pulling, memoised on the
 *  positions buffer (stable, resolver-owned) so tessellation runs once. */
const tessellationCache = new WeakMap<Float32Array, TessellatedPolygons>();

function getTessellation(positions: Float32Array, startIndices: Int32Array): TessellatedPolygons {
  const cached = tessellationCache.get(positions);
  if (cached) {
    return cached;
  }
  const tess = tessellateFlatPolygons(positions, startIndices);
  tessellationCache.set(positions, tess);
  return tess;
}

/**
 * Per-**feature** RGBA colours (the "table column → buffer" primitive), rebuilt only
 * when feature-state changes. Keyed on the feature-state runtime identity (which
 * changes exactly on a real feature-state change), so the returned buffer has a
 * **stable identity** across bare re-renders. This is `featureCount` texels — the
 * layer uploads it to a small texture and the shader samples it by feature index, so
 * the (large) geometry textures never re-upload. Hide/fade are folded into alpha.
 */
const featureColorsCache = new WeakMap<ShapeFeatureStateRuntime, Uint8Array>();

function getFeatureColors(
  featureState: ShapeFeatureStateRuntime,
  featureCount: number,
  colorForFeatureIndex: (index: number) => [number, number, number, number]
): Uint8Array {
  const cached = featureColorsCache.get(featureState);
  if (cached && cached.length === featureCount * 4) {
    return cached;
  }
  const colors = new Uint8Array(featureCount * 4);
  for (let f = 0; f < featureCount; f += 1) {
    const c = colorForFeatureIndex(f);
    colors[f * 4] = c[0];
    colors[f * 4 + 1] = c[1];
    colors[f * 4 + 2] = c[2];
    colors[f * 4 + 3] = c[3];
  }
  featureColorsCache.set(featureState, colors);
  return colors;
}

/**
 * Reconstruct a single feature's descriptor (including its polygon ring) from the
 * binary buffers. Called only at pick/tooltip time — one feature, so the nested
 * allocation the binary path avoids at load is negligible here.
 */
export function featureFromBinary(
  binary: ShapesBinaryPolygonData,
  index: number
): ShapePolygonRenderDatum | undefined {
  const featureId = binary.featureIds[index];
  if (!Number.isInteger(index) || index < 0 || !featureId) {
    return undefined;
  }
  const start = binary.startIndices[index];
  const end = binary.startIndices[index + 1];
  const ring: Array<[number, number]> = [];
  if (Number.isFinite(start) && Number.isFinite(end)) {
    for (let v = start; v < end; v += 1) {
      ring.push([binary.positions[v * 2], binary.positions[v * 2 + 1]]);
    }
  }
  const rowIndex = binary.rowIndexByFeatureIndex?.[index];
  return {
    featureId,
    featureIndex: index,
    polygon: [ring],
    rowIndex: rowIndex !== undefined && rowIndex >= 0 ? rowIndex : undefined,
  };
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

  if (renderData.polygonBinary) {
    // Binary path: no per-feature array is built at all — features are resolved by
    // index. `hiddenFeatureIds` is deliberately NOT applied here: hidden features
    // stay in the buffer (index alignment) and render transparent at colour time,
    // so this prebuilt is independent of the hidden set.
    return {
      geometryKind: 'polygon',
      data: [],
      binary: {
        positions: renderData.polygonBinary.positions,
        startIndices: renderData.polygonBinary.startIndices,
        featureIds: renderData.featureIds,
        rowIndexByFeatureIndex: renderData.rowIndexByFeatureIndex,
        tessellation: renderData.polygonBinary.tessellation,
      },
    };
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

function createBinaryPickHandler(
  layerId: string,
  elementKey: string,
  coordinateSystem: string | null | undefined,
  binary: ShapesBinaryPolygonData,
  callback: ((event: ShapesLayerPickEvent) => void) | undefined
) {
  if (!callback) {
    return undefined;
  }
  return (pickInfo: PickingInfo) => {
    // Binary layers surface only a picked `index`; reconstruct the feature from it.
    const feature =
      typeof pickInfo.index === 'number' ? featureFromBinary(binary, pickInfo.index) : undefined;
    if (!feature) {
      return;
    }
    callback({
      layerId,
      elementKey,
      featureId: feature.featureId,
      featureIndex: feature.featureIndex,
      coordinateSystem,
      rowIndex: feature.rowIndex,
      object: feature,
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
  if (prebuilt.binary) {
    return featureFromBinary(prebuilt.binary, pickInfo.index);
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
          value:
            'unmatched — shape index was not found in the associated table instance_key column',
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
  sublayer: SpatialShapesRuntimeSublayer,
  options: CreateShapesDeckLayerOptions
): Layer {
  const featureState = normalizeShapeFeatureState(sublayer.featureState);
  const defaultFillColor = sublayer.defaultFillColor ?? DEFAULT_SHAPE_FILL_COLOR;
  const resolvedDefaultStroke = sublayer.defaultStrokeColor ?? deriveStrokeColor(defaultFillColor);
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
        EMPTY_SHAPE_FEATURE_STATE_RUNTIME.fillColorByFeatureId,
        defaultFillColor,
        featureState
      ),
    getLineColor: (d) => resolveStrokeColor(d.featureId, featureState, resolvedDefaultStroke),
    getLineWidth: defaultStrokeWidth,
    lineWidthUnits: defaultStrokeWidthUnits,
    lineWidthMinPixels: defaultStrokeWidthMinPixels,
    lineWidthMaxPixels: defaultStrokeWidthMaxPixels,
    updateTriggers: {
      getFillColor: stableColorUpdateTrigger(featureState, defaultFillColor),
      getLineColor: stableColorUpdateTrigger(featureState, resolvedDefaultStroke),
      getLineWidth: [defaultStrokeWidth],
    },
    filled: true,
    stroked: true,
    opacity: options.opacity ?? 1,
    modelMatrix: options.modelMatrix,
    pickable: options.pickingEnabled ?? true,
    autoHighlight: options.pickingEnabled ?? true,
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
 * Render flat polygon geometry through a deck.gl `SolidPolygonLayer` in **binary
 * mode** — the coordinates never leave their typed-array form, so there is no
 * per-feature JS object and no per-vertex allocation.
 *
 * A single `FlatPolygonLayer` draws fill and outline together: the ring geometry is
 * tessellated into triangles carrying a boundary edge-distance, and the fragment
 * shader imputes an anti-aliased outline with `fwidth` — no separate outline layer
 * (the `PathLayer` outline was the pan/zoom regression at ~2.7M shapes; it
 * tessellated every ring into width-quads). The outline colour is a lighter
 * derivation of the fill, computed in the shader, so adjacent shapes read as
 * distinct.
 *
 * Feature-state is index-driven: colour is resolved once per feature and expanded to
 * the tessellated vertices; hidden features become transparent (dropped in the
 * shader), faded features get their alpha scaled. The per-vertex fill-colour buffer
 * is memoised on the feature-state runtime, whose identity changes on any
 * feature-state change — so deck re-uploads it exactly when it must, and never on a
 * bare re-render (the hover/pan buffer-thrash fix). Static geometry (positions,
 * edge-distances, picking colours) keeps a stable identity across all renders.
 *
 * NOTE: an explicit per-feature stroke override (`strokeColorByFeatureId`) is not yet
 * honoured on this path — the outline is always the lightened fill. The object path
 * still honours it; wiring it here is a follow-up.
 */
function createBinaryPolygonDeckLayers(
  binary: ShapesBinaryPolygonData,
  sublayer: SpatialShapesRuntimeSublayer,
  options: CreateShapesDeckLayerOptions
): Layer[] {
  const featureState = normalizeShapeFeatureState(sublayer.featureState);
  const defaultFillColor = sublayer.defaultFillColor ?? DEFAULT_SHAPE_FILL_COLOR;

  const { positions, startIndices, featureIds } = binary;

  // Prefer the topology tessellated off the main thread by the geometry worker; fall
  // back to lazy main-thread tessellation only when the worker path didn't provide it.
  const tess = binary.tessellation ?? getTessellation(positions, startIndices);
  if (tess.triangleCount === 0) {
    return [];
  }

  const fillColorAt = (index: number): [number, number, number, number] => {
    const featureId = featureIds[index];
    if (!featureId || featureState.hiddenFeatureIds.has(featureId)) {
      return TRANSPARENT_RGBA;
    }
    return resolveFeatureColor(
      featureId,
      featureState.fillColorByFeatureId,
      EMPTY_SHAPE_FEATURE_STATE_RUNTIME.fillColorByFeatureId,
      defaultFillColor,
      featureState
    );
  };

  const featureColors = getFeatureColors(featureState, featureIds.length, fillColorAt);

  const layer = new FlatPolygonLayer({
    id: options.id,
    ringPositions: tess.ringPositions,
    ringVertexCount: tess.ringVertexCount,
    triangleData: tess.triangleData,
    triangleCount: tess.triangleCount,
    featureScale: tess.featureScale,
    featureColors,
    featureCount: featureIds.length,
    strokeWidthPixels:
      sublayer.defaultStrokeWidthMaxPixels ?? DEFAULT_SHAPE_STROKE_WIDTH_MAX_PIXELS,
    opacity: options.opacity ?? 1,
    modelMatrix: options.modelMatrix,
    pickable: options.pickingEnabled ?? true,
    autoHighlight: options.pickingEnabled ?? true,
    highlightColor: [255, 255, 0, 128],
    onHover: createBinaryPickHandler(
      options.id,
      sublayer.elementKey,
      options.spatialCoordinateSystem,
      binary,
      options.onShapeHover
    ),
    onClick: createBinaryPickHandler(
      options.id,
      sublayer.elementKey,
      options.spatialCoordinateSystem,
      binary,
      options.onShapeClick
    ),
  } as unknown as ConstructorParameters<typeof FlatPolygonLayer>[0]);

  return [layer as unknown as Layer];
}

function createCircleDeckLayer(
  data: ShapeCircleRenderDatum[],
  geometryKind: 'circle' | 'point',
  sublayer: SpatialShapesRuntimeSublayer,
  options: CreateShapesDeckLayerOptions
): Layer {
  const featureState = normalizeShapeFeatureState(sublayer.featureState);
  const defaultFillColor = sublayer.defaultFillColor ?? DEFAULT_SHAPE_FILL_COLOR;
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
      getFillColor: stableColorUpdateTrigger(featureState, defaultFillColor),
    },
    opacity: options.opacity ?? 1,
    modelMatrix: options.modelMatrix,
    pickable: options.pickingEnabled ?? true,
    autoHighlight: options.pickingEnabled ?? true,
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
 *
 * The binary polygon path returns **two** layers (fill + outline); every other
 * path returns one. Callers must accept `Layer | Layer[]` — deck's `LayersList`
 * flattens nested arrays, so an array can be passed through unchanged.
 */
export function createShapesDeckLayer(
  renderData: ShapesRenderDataLike,
  sublayer: SpatialShapesRuntimeSublayer,
  options: CreateShapesDeckLayerOptions,
  prebuilt?: ShapesPrebuiltData
): Layer | Layer[] | null {
  if ((options.visible ?? sublayer.visible ?? true) === false) {
    return null;
  }

  if (prebuilt) {
    // Binary polygons first: their `data` is intentionally empty (features by
    // index), so the length check below must not short-circuit them.
    if (prebuilt.binary) {
      return prebuilt.binary.featureIds.length === 0
        ? null
        : createBinaryPolygonDeckLayers(prebuilt.binary, sublayer, options);
    }
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

  if (renderData.polygonBinary) {
    return renderData.featureIds.length === 0
      ? null
      : createBinaryPolygonDeckLayers(
          {
            positions: renderData.polygonBinary.positions,
            startIndices: renderData.polygonBinary.startIndices,
            featureIds: renderData.featureIds,
            rowIndexByFeatureIndex: renderData.rowIndexByFeatureIndex,
            tessellation: renderData.polygonBinary.tessellation,
          },
          sublayer,
          options
        );
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
