/**
 * Hook for loading and caching layer data
 *
 * Handles async loading of geometry data (shapes, points) and manages
 * loading state for each layer.
 */

import { getImageSize } from '@hms-dbmi/viv';
import type { Matrix4 } from '@math.gl/core';
import {
  COLOR_PALLETE,
  buildDefaultSelection,
  clampVivSelectionsToAxes,
  getMultiSelectionStats,
  getVivSelectionAxisSizes,
  guessRgb,
  isInterleaved,
  tryParseOmeroHexColor,
} from '@spatialdata/avivatorish';
import {
  type AxisAlignedBounds,
  type ImageElement,
  type LabelsElement,
  type LabelsTooltipMetadata,
  type PointsElement,
  type ShapesElement,
  type ShapesRenderData,
  type ShapesTooltipMetadata,
  type SpatialData,
  type SpatialFeatureTooltipData,
  attachTooltipElementContext,
  boundsFromCircles,
  boundsFromImagePixelExtents,
  boundsFromPoints,
  boundsFromPolygons,
  getPhysicalSizeScalingMatrixFromMeta,
  getTooltipSignature,
  loadAssociatedTableFeatureRows,
  loadLabelsTooltipMetadata,
  loadShapesTooltipMetadata,
  resolveTooltipItems,
  unionBoundsList,
} from '@spatialdata/core';
import {
  type ShapeFeatureRenderDatum,
  type ShapesPrebuiltData,
  buildShapeFeatureStateRuntime,
  buildShapesPrebuiltData,
  EMPTY_SHAPE_FEATURE_STATE_RUNTIME,
  type ShapeFeatureStateRuntime,
  resolveShapeFeatureFromPick,
  resolveShapeTooltipFromPickInfo,
  resolveShapeTooltipRowIndex,
} from '@spatialdata/layers';
import type { Layer } from 'deck.gl';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useVivLoaderRegistry } from './VivLoaderRegistry';
import {
  type VivLoaderMetadata,
  applyPerChannelFallbackWithoutOmero,
} from './imageLoaderChannelDefaults';
import { createImageLoader } from './renderers/imageRenderer';
import { renderLabelsLayer } from './renderers/labelsRenderer';
import { type PointData, renderPointsLayer } from './renderers/pointsRenderer';
import { loadShapesData, renderShapesLayer } from './renderers/shapesRenderer';
import { type ShapeFillColorMode, buildShapeFillColorByFeatureId } from './shapeColorEncoding';
import type { AvailableElement, ElementsByType, LayerConfig, ShapesLayerConfig } from './types';

export interface ImageLoaderData {
  loader: unknown;
  colors?: [number, number, number][];
  contrastLimits?: [number, number][];
  channelsVisible?: boolean[];
  selections?: Array<Partial<{ z: number; c: number; t: number }>>;
  /** Present when loader exposes `labels` / `shape`: dimension lengths for z, c, t (omit axes that do not exist). */
  selectionAxisSizes?: Partial<Record<'z' | 'c' | 't', number>>;
}

interface LoadedShapesData extends ShapesTooltipMetadata {
  renderData: ShapesRenderData;
}

interface ShapePrebuiltEntry {
  prebuilt: ShapesPrebuiltData;
  /** Serialised, sorted `hiddenFeatureIds` — used to detect when a rebuild is needed. */
  signature: string;
}

interface ShapeFillColorEntry {
  fillColorByFeatureId: Record<string, [number, number, number, number]>;
  signature: string;
}

export interface WorldBoundsCacheEntry {
  dataRef: unknown;
  transformRef: Matrix4;
  bounds: AxisAlignedBounds | null;
}

interface LoadedData {
  shapes: Map<string, LoadedShapesData>;
  points: Map<string, PointData>;
  images: Map<string, ImageLoaderData>; // Viv loaders with computed channel data
  labels: Map<string, LabelsLoaderData>;
  /**
   * Pre-built deck.gl `data` arrays keyed by **layer id** (not element key).
   * Each entry holds the O(n-features) array produced by `buildShapesPrebuiltData`
   * so that `getLayers()` never has to allocate it.  Invalidated only when
   * `hiddenFeatureIds` changes.
   */
  shapePrebuiltData: Map<string, ShapePrebuiltEntry>;
  /**
   * Per-layer table-column fill colour maps. Kept separate from element-keyed
   * geometry because two layers may render the same shapes with different
   * table columns.
   */
  shapeFillColorData: Map<string, ShapeFillColorEntry>;
  /**
   * World bounds keyed by element identity. Bounds depend on loaded geometry /
   * loader source and transform, not cosmetic layer props such as opacity.
   */
  worldBounds: Map<string, WorldBoundsCacheEntry>;
}

type ResourceLoadStatus = 'idle' | 'loading' | 'ready' | 'error';
type RasterSelection = Partial<{ z: number; c: number; t: number }>;

export interface LayerLoadState {
  geometry?: ResourceLoadStatus;
  image?: ResourceLoadStatus;
  tooltip?: ResourceLoadStatus;
}

export interface ImageLayerConfig {
  id: string;
  loader: unknown; // Viv PixelSource
  colors: [number, number, number][];
  contrastLimits: [number, number][];
  channelsVisible: boolean[];
  selections: Array<Partial<{ z: number; c: number; t: number }>>;
  modelMatrix?: Matrix4; // Transformation matrix for coordinate system alignment
  opacity?: number; // Layer opacity (0-1)
  visible?: boolean; // Whether layer is visible
}

export interface LabelsLoaderData extends LabelsTooltipMetadata {
  loader: unknown;
  colors: [number, number, number][];
  channelsVisible: boolean[];
  channelOpacities: number[];
  channelOutlineOpacities: number[];
  channelsFilled: boolean[];
  channelStrokeWidths: number[];
  selections: Array<Partial<{ z: number; c: number; t: number }>>;
  selectionAxisSizes?: Partial<Record<'z' | 'c' | 't', number>>;
}

interface UseLayerDataResult {
  /** Get deck.gl layers ready for rendering (shapes, points, etc.) */
  getLayers: () => Layer[];
  /** Get Viv layer props for image layers */
  getVivLayerProps: () => ImageLayerConfig[];
  /** Raw loaded image pipeline data (defaults) for the properties UI */
  getImageLayerLoadedData: (layerId: string) => ImageLoaderData | undefined;
  /** Raw loaded labels pipeline data (defaults) for the properties UI */
  getLabelsLayerLoadedData: (layerId: string) => LabelsLoaderData | undefined;
  /** Current load state for a given layer. */
  getLayerLoadState: (layerId?: string) => LayerLoadState | undefined;
  /** Whether a layer already has enough data to render. */
  hasRenderableLayerData: (layerId: string) => boolean;
  /** Resolve a feature tooltip lazily from the picked row index. */
  getFeatureTooltip: (
    layerId: string,
    pickInfo: Pick<{ index?: number; object?: unknown }, 'index' | 'object'>
  ) => SpatialFeatureTooltipData | undefined;
  /** Resolve stable shape feature metadata from a picked deck object. */
  getShapePickEvent: (
    layerId: string,
    pickInfo: Pick<{ index?: number; object?: unknown }, 'index' | 'object'>
  ) =>
    | {
        layerId: string;
        elementKey: string;
        featureId: string;
        featureIndex: number;
        rowIndex?: number;
        object: ShapeFeatureRenderDatum;
      }
    | undefined;
  /** Whether any layers are currently loading */
  isLoading: boolean;
  /** Whether any visible layer is still waiting on its first renderable resource. */
  isBlocking: boolean;
  /** Trigger a reload of data for a specific element */
  reloadElement: (type: string, key: string) => void;
  /** World-space axis-aligned bounds for one visible layer with loaded data, or null. */
  getWorldBoundsForLayer: (layerId: string) => AxisAlignedBounds | null;
  /** Union of bounds for all visible layers in order that have renderable data. */
  getWorldBoundsForVisibleLayers: () => AxisAlignedBounds | null;
}

function getLayerTooltipSignature(config: LayerConfig | undefined): string {
  return config && 'tooltipFields' in config ? getTooltipSignature(config.tooltipFields) : '';
}

function getShapeFillColorAlpha(config: ShapesLayerConfig): number {
  return config.fillColor?.[3] ?? 180;
}

function getShapeFillColorSignature(config: LayerConfig | undefined): string {
  if (!config || config.type !== 'shapes' || !config.fillColorByColumn?.columnName) {
    return '';
  }
  const mode: ShapeFillColorMode = config.fillColorByColumn.mode;
  return [config.fillColorByColumn.columnName, mode, String(getShapeFillColorAlpha(config))].join(
    '\u0001'
  );
}

/** Stable serialisation of `hiddenFeatureIds` for cache-invalidation comparison. */
function serializeHiddenIds(ids?: string[]): string {
  if (!ids || ids.length === 0) return '';
  return ids.slice().sort().join('\x00');
}

function serializeRasterSelections(selections: RasterSelection[]): string {
  return selections
    .map((selection) => `z:${selection.z ?? ''}|c:${selection.c ?? ''}|t:${selection.t ?? ''}`)
    .join('\x00');
}

function getElementMapKey(config: Pick<LayerConfig, 'type' | 'elementKey'>): string {
  return `${config.type}:${config.elementKey}`;
}

function getWorldBoundsCacheKey(elem: AvailableElement): string {
  return `${elem.type}:${elem.key}`;
}

export function resolveLayerElement(
  layerId: string,
  config: LayerConfig | undefined,
  elementMap: Map<string, AvailableElement>
): AvailableElement | undefined {
  if (!config) return undefined;
  return elementMap.get(getElementMapKey(config)) ?? elementMap.get(layerId);
}

export function getCachedWorldBounds(
  cache: Map<string, WorldBoundsCacheEntry>,
  key: string,
  dataRef: unknown,
  transformRef: Matrix4,
  compute: () => AxisAlignedBounds | null
): AxisAlignedBounds | null {
  const cached = cache.get(key);
  if (cached && cached.dataRef === dataRef && cached.transformRef === transformRef) {
    return cached.bounds;
  }
  const bounds = compute();
  cache.set(key, { dataRef, transformRef, bounds });
  return bounds;
}

async function loadShapesLayerData(
  element: ShapesElement
): Promise<Pick<LoadedShapesData, 'renderData'>> {
  const renderData = await loadShapesData(element);
  return { renderData };
}

async function loadShapeFillColorData({
  spatialData,
  element,
  renderData,
  config,
}: {
  spatialData: SpatialData | undefined;
  element: ShapesElement;
  renderData: ShapesRenderData;
  config: ShapesLayerConfig;
}): Promise<ShapeFillColorEntry> {
  const fillColorByColumn = config.fillColorByColumn;
  const signature = getShapeFillColorSignature(config);
  if (!fillColorByColumn?.columnName) {
    return { signature: '', fillColorByFeatureId: {} };
  }

  const rows = await loadAssociatedTableFeatureRows({
    spatialData,
    kind: 'shapes',
    key: element.key,
    extraColumnNames: [fillColorByColumn.columnName],
  });

  return {
    signature,
    fillColorByFeatureId: buildShapeFillColorByFeatureId({
      featureIds: renderData.featureIds,
      rowIndexByFeatureIndex: renderData.rowIndexByFeatureIndex,
      column: rows.extraColumns?.[0],
      mode: fillColorByColumn.mode,
      alpha: getShapeFillColorAlpha(config),
    }),
  };
}

function mergeShapeFeatureStateForRender(
  config: ShapesLayerConfig,
  fillColorEntry: ShapeFillColorEntry | undefined
): ShapesLayerConfig['featureState'] {
  if (!config.fillColorByColumn?.columnName) {
    return config.featureState;
  }
  return {
    ...config.featureState,
    fillColorByFeatureId: fillColorEntry?.fillColorByFeatureId ?? {},
    strokeColorByFeatureId: fillColorEntry?.fillColorByFeatureId ?? {},
  };
}

function getShapeFeatureStateSignature(
  config: ShapesLayerConfig,
  fillColorEntry: ShapeFillColorEntry | undefined
): string {
  const featureState = config.featureState;
  const fillColors = featureState?.fillColorByFeatureId;
  const strokeColors = featureState?.strokeColorByFeatureId;
  return [
    serializeHiddenIds(featureState?.hiddenFeatureIds),
    serializeHiddenIds(featureState?.fadedFeatureIds),
    String(featureState?.filteredOpacityMultiplier ?? ''),
    fillColorEntry?.signature ?? '',
    fillColors ? `\x02${Object.keys(fillColors).length}:${fillColors}` : '',
    strokeColors ? `\x02${Object.keys(strokeColors).length}:${strokeColors}` : '',
  ].join('\x01');
}

function getStableShapeFeatureStateRuntime(
  layerId: string,
  config: ShapesLayerConfig,
  fillColorEntry: ShapeFillColorEntry | undefined,
  cache: Map<string, { signature: string; runtime: ShapeFeatureStateRuntime }>
): ShapeFeatureStateRuntime {
  const signature = getShapeFeatureStateSignature(config, fillColorEntry);
  const cached = cache.get(layerId);
  if (cached?.signature === signature) {
    return cached.runtime;
  }

  const merged = mergeShapeFeatureStateForRender(config, fillColorEntry);
  const runtime = merged
    ? buildShapeFeatureStateRuntime(merged)
    : EMPTY_SHAPE_FEATURE_STATE_RUNTIME;
  cache.set(layerId, { signature, runtime });
  return runtime;
}

/**
 * Hook to manage async loading of layer data and produce deck.gl layers.
 *
 * This hook:
 * 1. Watches for changes to enabled layers
 * 2. Loads data for newly enabled layers
 * 3. Caches loaded data
 * 4. Produces deck.gl Layer instances with the loaded data
 */
export function useLayerData(
  layers: Record<string, LayerConfig>,
  layerOrder: string[],
  availableElements: ElementsByType,
  coordinateSystem: string | null,
  spatialData?: SpatialData
): UseLayerDataResult {
  const { getOmeZarrMultiscalesData } = useVivLoaderRegistry();

  // Cache for loaded data
  const loadedDataRef = useRef<LoadedData>({
    shapes: new Map(),
    points: new Map(),
    images: new Map(),
    labels: new Map(),
    shapePrebuiltData: new Map(),
    shapeFillColorData: new Map(),
    worldBounds: new Map(),
  });
  const stableSelectionArraysRef = useRef<
    Map<string, { signature: string; value: RasterSelection[] }>
  >(new Map());
  const stableShapeFeatureStateRef = useRef<
    Map<string, { signature: string; runtime: ShapeFeatureStateRuntime }>
  >(new Map());

  const layersRef = useRef(layers);
  layersRef.current = layers;

  const [layerLoadStates, setLayerLoadStates] = useState<Record<string, LayerLoadState>>({});
  const [, setLoadedDataRevision] = useState(0);

  const notifyLoadedDataChanged = useCallback(() => {
    setLoadedDataRevision((revision) => revision + 1);
  }, []);

  // Build a map of element key -> AvailableElement for quick lookup
  const elementMap = useRef<Map<string, AvailableElement>>(new Map());

  useEffect(() => {
    const map = new Map<string, AvailableElement>();
    for (const type of ['images', 'shapes', 'points', 'labels'] as const) {
      for (const elem of availableElements[type]) {
        map.set(`${elem.type}:${elem.key}`, elem);
      }
    }
    elementMap.current = map;
  }, [availableElements]);

  const setLayerResourceStatus = useCallback(
    (layerId: string, resource: keyof LayerLoadState, status: ResourceLoadStatus) => {
      setLayerLoadStates((prev) => {
        const existing = prev[layerId] ?? {};
        if (existing[resource] === status) {
          return prev;
        }
        return {
          ...prev,
          [layerId]: {
            ...existing,
            [resource]: status,
          },
        };
      });
    },
    []
  );

  // Load data for enabled layers that don't have data yet
  useEffect(() => {
    const loadData = async () => {
      const loaded = loadedDataRef.current;

      // ── Synchronous prebuilt invalidation ──────────────────────────────────
      // Rebuild the pre-filtered feature arrays when hiddenFeatureIds changes.
      // This is O(n-features) CPU work on already-loaded geometry; no IO.
      for (const layerId of layerOrder) {
        const config = layers[layerId];
        if (!config?.visible || config.type !== 'shapes') continue;
        const elem = resolveLayerElement(layerId, config, elementMap.current);
        if (!elem) continue;
        const loadedShapes = loaded.shapes.get(elem.key);
        if (!loadedShapes) continue;
        const hiddenIds = config.featureState?.hiddenFeatureIds;
        const sig = serializeHiddenIds(hiddenIds);
        const cached = loaded.shapePrebuiltData.get(layerId);
        if (!cached || cached.signature !== sig) {
          loaded.shapePrebuiltData.set(layerId, {
            prebuilt: buildShapesPrebuiltData(loadedShapes.renderData, hiddenIds),
            signature: sig,
          });
        }
      }
      // ── Async IO loads ─────────────────────────────────────────────────────

      const toLoad: Array<{
        layerId: string;
        element: AvailableElement;
        loadGeometry: boolean;
        loadTooltip: boolean;
        loadFillColor: boolean;
        loadImage: boolean;
        loadPoints: boolean;
        loadLabels: boolean;
      }> = [];

      for (const layerId of layerOrder) {
        const config = layers[layerId];
        if (!config?.visible) continue;

        const elem = resolveLayerElement(layerId, config, elementMap.current);
        if (!elem) continue;

        if (config.type === 'shapes') {
          const loadedShapes = loaded.shapes.get(elem.key);
          const tooltipSignature = getLayerTooltipSignature(config);
          const fillColorSignature = getShapeFillColorSignature(config);
          const fillColorEntry = loaded.shapeFillColorData.get(layerId);
          const loadGeometry = !loadedShapes;
          const loadTooltip = !loadedShapes || loadedShapes.tooltipSignature !== tooltipSignature;
          const loadFillColor = fillColorSignature
            ? fillColorEntry?.signature !== fillColorSignature
            : fillColorEntry !== undefined;
          if (loadGeometry || loadTooltip || loadFillColor) {
            toLoad.push({
              layerId,
              element: elem,
              loadGeometry,
              loadTooltip,
              loadFillColor,
              loadImage: false,
              loadPoints: false,
              loadLabels: false,
            });
          }
        } else if (config.type === 'labels') {
          const loadedLabels = loaded.labels.get(elem.key);
          const tooltipSignature = getLayerTooltipSignature(config);
          const loadLabels = !loadedLabels;
          const loadTooltip = !loadedLabels || loadedLabels.tooltipSignature !== tooltipSignature;
          if (loadLabels || loadTooltip) {
            toLoad.push({
              layerId,
              element: elem,
              loadGeometry: false,
              loadTooltip,
              loadFillColor: false,
              loadImage: false,
              loadPoints: false,
              loadLabels,
            });
          }
        } else if (config.type === 'points' && !loaded.points.has(elem.key)) {
          toLoad.push({
            layerId,
            element: elem,
            loadGeometry: false,
            loadTooltip: false,
            loadFillColor: false,
            loadImage: false,
            loadPoints: true,
            loadLabels: false,
          });
        } else if (config.type === 'image' && !loaded.images.has(elem.key)) {
          toLoad.push({
            layerId,
            element: elem,
            loadGeometry: false,
            loadTooltip: false,
            loadFillColor: false,
            loadImage: true,
            loadPoints: false,
            loadLabels: false,
          });
        }
      }

      if (toLoad.length === 0) return;

      // Load in parallel
      await Promise.all(
        toLoad.map(
          async ({
            layerId,
            element,
            loadGeometry,
            loadTooltip,
            loadFillColor,
            loadImage,
            loadPoints,
            loadLabels,
          }) => {
            if (element.type === 'shapes') {
              const existing = loadedDataRef.current.shapes.get(element.key);
              if (loadGeometry) {
                try {
                  setLayerResourceStatus(layerId, 'geometry', 'loading');
                  const geometryData = await loadShapesLayerData(element.element as ShapesElement);
                  loadedDataRef.current.shapes.set(element.key, {
                    ...existing,
                    ...geometryData,
                  });
                  setLayerResourceStatus(layerId, 'geometry', 'ready');
                  // Build the initial prebuilt data for this layer.
                  const curConfig = layersRef.current[layerId];
                  const hiddenIds =
                    curConfig?.type === 'shapes'
                      ? curConfig.featureState?.hiddenFeatureIds
                      : undefined;
                  loadedDataRef.current.shapePrebuiltData.set(layerId, {
                    prebuilt: buildShapesPrebuiltData(geometryData.renderData, hiddenIds),
                    signature: serializeHiddenIds(hiddenIds),
                  });
                } catch (error) {
                  setLayerResourceStatus(layerId, 'geometry', 'error');
                  console.error(`Failed to load shapes geometry for ${layerId}:`, error);
                  return;
                }
              } else {
                setLayerResourceStatus(layerId, 'geometry', existing ? 'ready' : 'idle');
              }

              if (loadTooltip) {
                try {
                  const shapeLayerConfig =
                    layersRef.current[layerId]?.type === 'shapes'
                      ? layersRef.current[layerId]
                      : undefined;
                  const tooltipFields = shapeLayerConfig?.tooltipFields ?? [];
                  const requestedSignature = getLayerTooltipSignature(shapeLayerConfig);
                  if (tooltipFields.length > 0) {
                    setLayerResourceStatus(layerId, 'tooltip', 'loading');
                    const current = loadedDataRef.current.shapes.get(element.key);
                    const tooltipData = await loadShapesTooltipMetadata(
                      spatialData,
                      element.element as ShapesElement,
                      tooltipFields
                    );
                    const latestDesired = getLayerTooltipSignature(
                      layersRef.current[layerId]?.type === 'shapes'
                        ? layersRef.current[layerId]
                        : undefined
                    );
                    if (latestDesired !== requestedSignature) {
                      return;
                    }
                    const mergedShapeData = {
                      ...current,
                      ...tooltipData,
                    } as LoadedShapesData;
                    if (tooltipData.tooltipRowIndices) {
                      mergedShapeData.renderData = {
                        ...mergedShapeData.renderData,
                        rowIndexByFeatureIndex: tooltipData.tooltipRowIndices,
                      };
                      const hiddenIds =
                        layersRef.current[layerId]?.type === 'shapes'
                          ? layersRef.current[layerId].featureState?.hiddenFeatureIds
                          : undefined;
                      loadedDataRef.current.shapePrebuiltData.set(layerId, {
                        prebuilt: buildShapesPrebuiltData(mergedShapeData.renderData, hiddenIds),
                        signature: serializeHiddenIds(hiddenIds),
                      });
                    }
                    loadedDataRef.current.shapes.set(element.key, mergedShapeData);
                    setLayerResourceStatus(
                      layerId,
                      'tooltip',
                      tooltipData.tooltipSignature === undefined ? 'idle' : 'ready'
                    );
                  } else {
                    const current = loadedDataRef.current.shapes.get(element.key);
                    loadedDataRef.current.shapes.set(element.key, {
                      ...current,
                      tooltipSignature: '',
                      tooltipFields: [],
                      tooltipColumns: undefined,
                      tooltipRowIndices: undefined,
                      tooltipRowIndexByFeatureId: undefined,
                    } as LoadedShapesData);
                    setLayerResourceStatus(layerId, 'tooltip', 'idle');
                  }
                } catch (error) {
                  setLayerResourceStatus(layerId, 'tooltip', 'error');
                  console.error(`Failed to load shapes tooltip for ${layerId}:`, error);
                }
              }

              if (loadFillColor) {
                const shapeLayerConfig =
                  layersRef.current[layerId]?.type === 'shapes'
                    ? layersRef.current[layerId]
                    : undefined;
                const requestedSignature = getShapeFillColorSignature(shapeLayerConfig);
                if (!shapeLayerConfig || !requestedSignature) {
                  loadedDataRef.current.shapeFillColorData.delete(layerId);
                  notifyLoadedDataChanged();
                } else {
                  try {
                    const current = loadedDataRef.current.shapes.get(element.key);
                    if (!current?.renderData) {
                      return;
                    }
                    const fillColorData = await loadShapeFillColorData({
                      spatialData,
                      element: element.element as ShapesElement,
                      renderData: current.renderData,
                      config: shapeLayerConfig,
                    });
                    const latestDesired = getShapeFillColorSignature(
                      layersRef.current[layerId]?.type === 'shapes'
                        ? layersRef.current[layerId]
                        : undefined
                    );
                    if (latestDesired !== requestedSignature) {
                      return;
                    }
                    loadedDataRef.current.shapeFillColorData.set(layerId, fillColorData);
                    notifyLoadedDataChanged();
                  } catch (error) {
                    loadedDataRef.current.shapeFillColorData.delete(layerId);
                    notifyLoadedDataChanged();
                    console.error(`Failed to load shapes fill colours for ${layerId}:`, error);
                  }
                }
              }
            } else if (element.type === 'points' && loadPoints) {
              try {
                setLayerResourceStatus(layerId, 'geometry', 'loading');
                // todo better type-guards etc here.
                const e = element.element as PointsElement;
                const data = await e.loadPoints();
                loadedDataRef.current.points.set(element.key, data);
                setLayerResourceStatus(layerId, 'geometry', 'ready');
              } catch (error) {
                setLayerResourceStatus(layerId, 'geometry', 'error');
                console.error(`Failed to load points for ${layerId}:`, error);
              }
            } else if (element.type === 'image' && loadImage) {
              try {
                setLayerResourceStatus(layerId, 'image', 'loading');
                const loader = await createImageLoader(
                  element.element as ImageElement,
                  getOmeZarrMultiscalesData
                );
                // Compute channel defaults from loader metadata
                const imageElement = element.element as ImageElement;
                const loaderToCheck = Array.isArray(loader) ? loader[0] : loader;

                const imageData: ImageLoaderData = { loader };

                try {
                  if (
                    loaderToCheck &&
                    typeof loaderToCheck === 'object' &&
                    'labels' in loaderToCheck &&
                    'shape' in loaderToCheck
                  ) {
                    const loaderObj = loaderToCheck as VivLoaderMetadata;
                    imageData.selectionAxisSizes = getVivSelectionAxisSizes(
                      loaderObj.labels,
                      loaderObj.shape
                    );

                    // Build selections
                    const selections = buildDefaultSelection({
                      labels: loaderObj.labels,
                      shape: loaderObj.shape,
                    });

                    // Get metadata from image element
                    const metadata = imageElement.attrs.omero;

                    if (metadata?.channels) {
                      const Channels = metadata.channels;
                      const isRgb = guessRgb({
                        Pixels: { Channels: Channels.map((c: any) => ({ Name: c.label })) },
                      });

                      if (isRgb) {
                        if (isInterleaved(loaderObj.shape)) {
                          imageData.contrastLimits = [[0, 255]];
                          imageData.colors = [[255, 0, 0]];
                        } else {
                          imageData.contrastLimits = [
                            [0, 255],
                            [0, 255],
                            [0, 255],
                          ];
                          imageData.colors = [
                            [255, 0, 0],
                            [0, 255, 0],
                            [0, 0, 255],
                          ];
                        }
                        imageData.channelsVisible = imageData.colors.map(() => true);
                      } else {
                        // Compute stats for non-RGB images
                        const stats = await getMultiSelectionStats({
                          loader,
                          selections,
                          use3d: false,
                        });
                        imageData.contrastLimits = stats.contrastLimits;
                        // Use channel colors from metadata or palette
                        const computedColors: [number, number, number][] =
                          stats.contrastLimits.length === 1
                            ? [[255, 255, 255]]
                            : stats.contrastLimits.map((_, i): [number, number, number] => {
                                const rgb = tryParseOmeroHexColor(Channels[i]?.color);
                                const p = COLOR_PALLETE[i % COLOR_PALLETE.length];
                                return rgb ?? [p[0], p[1], p[2]];
                              });
                        imageData.colors = computedColors;
                        imageData.channelsVisible = computedColors.map(() => true);
                      }
                      imageData.selections = selections;
                    } else {
                      applyPerChannelFallbackWithoutOmero(imageData, loaderObj, selections);
                    }
                  } else {
                    imageData.contrastLimits = [[0, 65535]];
                    imageData.colors = [[255, 255, 255]];
                    imageData.channelsVisible = [true];
                    imageData.selections = [{}];
                  }
                } catch (error) {
                  console.warn(`Failed to compute channel defaults for ${element.key}:`, error);
                  const fallbackLoader =
                    loaderToCheck &&
                    typeof loaderToCheck === 'object' &&
                    'labels' in loaderToCheck &&
                    'shape' in loaderToCheck
                      ? (loaderToCheck as VivLoaderMetadata)
                      : undefined;
                  if (fallbackLoader) {
                    try {
                      imageData.selectionAxisSizes =
                        imageData.selectionAxisSizes ??
                        getVivSelectionAxisSizes(fallbackLoader.labels, fallbackLoader.shape);
                      const fallbackSelections = buildDefaultSelection({
                        labels: fallbackLoader.labels,
                        shape: fallbackLoader.shape,
                      });
                      applyPerChannelFallbackWithoutOmero(
                        imageData,
                        fallbackLoader,
                        fallbackSelections
                      );
                    } catch {
                      imageData.contrastLimits = [[0, 65535]];
                      imageData.colors = [[255, 255, 255]];
                      imageData.channelsVisible = [true];
                      imageData.selections = [{}];
                    }
                  } else {
                    imageData.contrastLimits = [[0, 65535]];
                    imageData.colors = [[255, 255, 255]];
                    imageData.channelsVisible = [true];
                    imageData.selections = [{}];
                  }
                }

                loadedDataRef.current.images.set(element.key, imageData);
                setLayerResourceStatus(layerId, 'image', 'ready');
              } catch (error) {
                setLayerResourceStatus(layerId, 'image', 'error');
                console.error(`Failed to load image for ${layerId}:`, error);
              }
            } else if (element.type === 'labels') {
              const existing = loadedDataRef.current.labels.get(element.key);
              if (loadLabels) {
                try {
                  setLayerResourceStatus(layerId, 'image', 'loading');
                  const loader = await createImageLoader(
                    element.element as LabelsElement,
                    getOmeZarrMultiscalesData
                  );
                  const loaderToCheck = Array.isArray(loader) ? loader[0] : loader;
                  const labelsData: LabelsLoaderData = {
                    loader,
                    colors: [[255, 255, 255]],
                    channelsVisible: [true],
                    channelOpacities: [0.18],
                    channelOutlineOpacities: [0.95],
                    channelsFilled: [true],
                    channelStrokeWidths: [1.5],
                    selections: [{}],
                  };

                  if (
                    loaderToCheck &&
                    typeof loaderToCheck === 'object' &&
                    'labels' in loaderToCheck &&
                    'shape' in loaderToCheck
                  ) {
                    const loaderObj = loaderToCheck as VivLoaderMetadata;
                    const axisSizes = getVivSelectionAxisSizes(loaderObj.labels, loaderObj.shape);
                    const selections = clampVivSelectionsToAxes(
                      buildDefaultSelection({
                        labels: loaderObj.labels,
                        shape: loaderObj.shape,
                      }),
                      axisSizes
                    ).slice(0, 1);
                    const metadataChannels = (element.element as LabelsElement).attrs.omero
                      ?.channels;

                    const rgb = tryParseOmeroHexColor(metadataChannels?.[0]?.color);
                    const palette = COLOR_PALLETE[0];
                    const color: [number, number, number] = rgb ?? [
                      palette[0],
                      palette[1],
                      palette[2],
                    ];

                    labelsData.selectionAxisSizes = axisSizes;
                    labelsData.selections = selections.length > 0 ? selections : [{}];
                    labelsData.colors = [color];
                    labelsData.channelsVisible = [metadataChannels?.[0]?.active ?? true];
                    labelsData.channelOpacities = [0.18];
                    labelsData.channelOutlineOpacities = [0.95];
                    labelsData.channelsFilled = [true];
                    labelsData.channelStrokeWidths = [1.5];
                  }

                  loadedDataRef.current.labels.set(element.key, {
                    ...existing,
                    ...labelsData,
                  });
                  setLayerResourceStatus(layerId, 'image', 'ready');
                } catch (error) {
                  setLayerResourceStatus(layerId, 'image', 'error');
                  console.error(`Failed to load labels for ${layerId}:`, error);
                  return;
                }
              } else {
                setLayerResourceStatus(layerId, 'image', existing ? 'ready' : 'idle');
              }

              if (loadTooltip) {
                try {
                  const labelsLayerConfig =
                    layersRef.current[layerId]?.type === 'labels'
                      ? layersRef.current[layerId]
                      : undefined;
                  const tooltipFields = labelsLayerConfig?.tooltipFields ?? [];
                  const requestedSignature = getLayerTooltipSignature(labelsLayerConfig);
                  if (tooltipFields.length > 0) {
                    setLayerResourceStatus(layerId, 'tooltip', 'loading');
                    const current = loadedDataRef.current.labels.get(element.key);
                    const tooltipData = await loadLabelsTooltipMetadata(
                      spatialData,
                      element.element as LabelsElement,
                      tooltipFields
                    );
                    const latestDesired = getLayerTooltipSignature(
                      layersRef.current[layerId]?.type === 'labels'
                        ? layersRef.current[layerId]
                        : undefined
                    );
                    if (latestDesired !== requestedSignature) {
                      return;
                    }
                    loadedDataRef.current.labels.set(element.key, {
                      ...current,
                      ...tooltipData,
                    } as LabelsLoaderData);
                    setLayerResourceStatus(
                      layerId,
                      'tooltip',
                      tooltipData.tooltipSignature === undefined ? 'idle' : 'ready'
                    );
                  } else {
                    const current = loadedDataRef.current.labels.get(element.key);
                    loadedDataRef.current.labels.set(element.key, {
                      ...current,
                      tooltipSignature: '',
                      tooltipFields: [],
                      tooltipColumns: undefined,
                      tooltipRowIndexByFeatureId: undefined,
                    } as LabelsLoaderData);
                    setLayerResourceStatus(layerId, 'tooltip', 'idle');
                  }
                } catch (error) {
                  setLayerResourceStatus(layerId, 'tooltip', 'error');
                  console.error(`Failed to load labels tooltip for ${layerId}:`, error);
                }
              }
            }
          }
        )
      );
    };

    loadData();
  }, [
    layers,
    layerOrder,
    getOmeZarrMultiscalesData,
    spatialData,
    setLayerResourceStatus,
    notifyLoadedDataChanged,
  ]);

  const reloadElement = useCallback((type: string, key: string) => {
    const loaded = loadedDataRef.current;
    if (type === 'shapes') {
      loaded.shapes.delete(key);
      loaded.worldBounds.delete(`shapes:${key}`);
      // Clear prebuilt data for every layer that maps to this element key.
      for (const [layerId, config] of Object.entries(layersRef.current)) {
        if (config.type === 'shapes' && config.elementKey === key) {
          loaded.shapePrebuiltData.delete(layerId);
          loaded.shapeFillColorData.delete(layerId);
        }
      }
    } else if (type === 'points') {
      loaded.points.delete(key);
      loaded.worldBounds.delete(`points:${key}`);
    } else if (type === 'image') {
      loaded.images.delete(key);
      loaded.worldBounds.delete(`image:${key}`);
    } else if (type === 'labels') {
      loaded.labels.delete(key);
      loaded.worldBounds.delete(`labels:${key}`);
    }
    // The useEffect will pick up the missing data and reload
  }, []);

  const getStableSelections = useCallback((key: string, selections: RasterSelection[]) => {
    const signature = serializeRasterSelections(selections);
    const cached = stableSelectionArraysRef.current.get(key);
    if (cached?.signature === signature) {
      return cached.value;
    }
    const value = selections.map((selection) => ({ ...selection }));
    stableSelectionArraysRef.current.set(key, { signature, value });
    return value;
  }, []);

  const hasRenderableLayerData = useCallback((layerId: string): boolean => {
    const elem = resolveLayerElement(layerId, layersRef.current[layerId], elementMap.current);
    if (!elem) return false;
    if (elem.type === 'shapes') {
      return loadedDataRef.current.shapes.has(elem.key);
    }
    if (elem.type === 'points') {
      return loadedDataRef.current.points.has(elem.key);
    }
    if (elem.type === 'image') {
      return loadedDataRef.current.images.has(elem.key);
    }
    if (elem.type === 'labels') {
      return loadedDataRef.current.labels.has(elem.key);
    }
    return false;
  }, []);

  const getWorldBoundsForLayer = useCallback(
    (layerId: string): AxisAlignedBounds | null => {
      try {
        const config = layers[layerId];
        const elem = resolveLayerElement(layerId, config, elementMap.current);
        if (!config?.visible || !elem) return null;
        const loaded = loadedDataRef.current;
        if (elem.type === 'shapes') {
          const shapeData = loaded.shapes.get(elem.key);
          if (!shapeData) return null;
          const { renderData } = shapeData;
          return getCachedWorldBounds(
            loaded.worldBounds,
            getWorldBoundsCacheKey(elem),
            renderData,
            elem.transform,
            () => {
              if (
                (renderData.geometryKind === 'circle' || renderData.geometryKind === 'point') &&
                renderData.circles
              ) {
                return boundsFromCircles(renderData.circles, elem.transform);
              }
              if (!renderData.polygons?.length) return null;
              return boundsFromPolygons(renderData.polygons, elem.transform);
            }
          );
        }
        if (elem.type === 'points') {
          const pointData = loaded.points.get(elem.key);
          if (!pointData) return null;
          return getCachedWorldBounds(
            loaded.worldBounds,
            getWorldBoundsCacheKey(elem),
            pointData,
            elem.transform,
            () => boundsFromPoints(pointData, elem.transform, false)
          );
        }
        if (elem.type === 'image') {
          const imageData = loaded.images.get(elem.key);
          if (!imageData?.loader) return null;
          const source = Array.isArray(imageData.loader) ? imageData.loader[0] : imageData.loader;
          if (!source || typeof source !== 'object') return null;
          return getCachedWorldBounds(
            loaded.worldBounds,
            getWorldBoundsCacheKey(elem),
            source,
            elem.transform,
            () => {
              const { width, height } = getImageSize(source as never);
              const physical = getPhysicalSizeScalingMatrixFromMeta(source);
              return boundsFromImagePixelExtents(width, height, elem.transform, physical);
            }
          );
        }
        if (elem.type === 'labels') {
          const labelsData = loaded.labels.get(elem.key);
          if (!labelsData?.loader) return null;
          const source = Array.isArray(labelsData.loader)
            ? labelsData.loader[0]
            : labelsData.loader;
          if (!source || typeof source !== 'object') return null;
          return getCachedWorldBounds(
            loaded.worldBounds,
            getWorldBoundsCacheKey(elem),
            source,
            elem.transform,
            () => {
              const { width, height } = getImageSize(source as never);
              const physical = getPhysicalSizeScalingMatrixFromMeta(source);
              return boundsFromImagePixelExtents(width, height, elem.transform, physical);
            }
          );
        }
        return null;
      } catch (err) {
        console.warn(`[useLayerData] getWorldBoundsForLayer failed for ${layerId}`, err);
        return null;
      }
    },
    [layers]
  );

  const getWorldBoundsForVisibleLayers = useCallback((): AxisAlignedBounds | null => {
    const list: AxisAlignedBounds[] = [];
    for (const layerId of layerOrder) {
      const config = layers[layerId];
      if (!config?.visible) continue;
      const b = getWorldBoundsForLayer(layerId);
      if (b) list.push(b);
    }
    return unionBoundsList(list);
  }, [layerOrder, layers, getWorldBoundsForLayer]);

  const getLayers = useCallback((): Layer[] => {
    const deckLayers: Layer[] = [];
    const loaded = loadedDataRef.current;

    for (const layerId of layerOrder) {
      const config = layers[layerId];
      if (!config?.visible) continue;

      const elem = resolveLayerElement(layerId, config, elementMap.current);
      if (!elem) continue;

      if (config.type === 'shapes') {
        const shapeData = loaded.shapes.get(elem.key);
        if (shapeData) {
          const layer = renderShapesLayer({
            element: elem.element as ShapesElement,
            id: layerId,
            modelMatrix: elem.transform,
            opacity: config.opacity,
            visible: config.visible,
            fillColor: config.fillColor,
            strokeColor: config.strokeColor,
            strokeWidth: config.strokeWidth,
            strokeWidthUnits: config.strokeWidthUnits,
            strokeWidthMinPixels: config.strokeWidthMinPixels,
            strokeWidthMaxPixels: config.strokeWidthMaxPixels,
            featureStateRuntime: getStableShapeFeatureStateRuntime(
              layerId,
              config,
              loaded.shapeFillColorData.get(layerId),
              stableShapeFeatureStateRef.current
            ),
            renderData: shapeData.renderData,
            prebuilt: loaded.shapePrebuiltData.get(layerId)?.prebuilt,
          });
          if (layer) deckLayers.push(layer);
        }
      } else if (config.type === 'points') {
        const pointData = loaded.points.get(elem.key);
        if (pointData) {
          const layer = renderPointsLayer({
            element: elem.element as PointsElement,
            id: layerId,
            modelMatrix: elem.transform,
            opacity: config.opacity,
            visible: config.visible,
            pointSize: config.pointSize,
            color: config.color,
            pointData,
          });
          if (layer) deckLayers.push(layer);
        }
      } else if (config.type === 'labels') {
        const labelsData = loaded.labels.get(elem.key);
        if (labelsData) {
          const ch = config.channels;
          const rawSelections =
            ch?.selections && ch.selections.length > 0 ? ch.selections : labelsData.selections;
          const selections =
            labelsData.selectionAxisSizes !== undefined
              ? clampVivSelectionsToAxes(rawSelections, labelsData.selectionAxisSizes)
              : rawSelections;
          const stableSelections = getStableSelections(`labels:${layerId}`, selections);

          const layer = renderLabelsLayer({
            id: layerId,
            loader: labelsData.loader,
            modelMatrix: elem.transform,
            opacity: config.opacity,
            visible: config.visible,
            channelColors: ch?.colors && ch.colors.length > 0 ? ch.colors : labelsData.colors,
            channelsVisible:
              ch?.channelsVisible && ch.channelsVisible.length > 0
                ? ch.channelsVisible
                : labelsData.channelsVisible,
            channelOpacities:
              ch?.channelOpacities && ch.channelOpacities.length > 0
                ? ch.channelOpacities
                : labelsData.channelOpacities,
            channelOutlineOpacities:
              ch?.channelOutlineOpacities && ch.channelOutlineOpacities.length > 0
                ? ch.channelOutlineOpacities
                : labelsData.channelOutlineOpacities,
            channelsFilled:
              ch?.channelsFilled && ch.channelsFilled.length > 0
                ? ch.channelsFilled
                : labelsData.channelsFilled,
            channelStrokeWidths:
              ch?.channelStrokeWidths && ch.channelStrokeWidths.length > 0
                ? ch.channelStrokeWidths
                : labelsData.channelStrokeWidths,
            selections: stableSelections,
          });
          if (layer) deckLayers.push(layer);
        }
      }
      // Image layers are handled separately via getVivLayerProps()
    }

    return deckLayers;
  }, [layers, layerOrder, getStableSelections]);

  const getImageLayerLoadedData = useCallback((layerId: string): ImageLoaderData | undefined => {
    const elem = resolveLayerElement(layerId, layersRef.current[layerId], elementMap.current);
    if (!elem || elem.type !== 'image') return undefined;
    return loadedDataRef.current.images.get(elem.key);
  }, []);

  const getLabelsLayerLoadedData = useCallback((layerId: string): LabelsLoaderData | undefined => {
    const elem = resolveLayerElement(layerId, layersRef.current[layerId], elementMap.current);
    if (!elem || elem.type !== 'labels') return undefined;
    return loadedDataRef.current.labels.get(elem.key);
  }, []);

  const getLayerLoadState = useCallback(
    (layerId?: string): LayerLoadState | undefined => {
      if (layerId === undefined) return undefined;
      return layerLoadStates[layerId];
    },
    [layerLoadStates]
  );

  const getFeatureTooltip = useCallback(
    (
      layerId: string,
      pickInfo: Pick<{ index?: number; object?: unknown }, 'index' | 'object'>
    ): SpatialFeatureTooltipData | undefined => {
      const elem = resolveLayerElement(layerId, layersRef.current[layerId], elementMap.current);
      if (!elem) {
        return undefined;
      }

      const elementContext = {
        elementKey: elem.key,
        elementType: elem.type,
        layerId,
      };

      if (elem.type === 'labels') {
        const pickedObject = pickInfo.object as
          | { labelId?: number | string; channelIndex?: number }
          | undefined;
        const rawLabelId = pickedObject?.labelId;
        const labelId = rawLabelId === undefined || rawLabelId === null ? '' : String(rawLabelId);
        if (!labelId) {
          return undefined;
        }

        const loadedLabelData = loadedDataRef.current.labels.get(elem.key);
        const config = layersRef.current[layerId];
        const items: Array<{ label: string; value: string }> = [{ label: 'id', value: labelId }];

        if (
          config?.type === 'labels' &&
          (config.tooltipFields?.length ?? 0) > 0 &&
          loadedLabelData?.tooltipFields &&
          loadedLabelData.tooltipColumns &&
          loadedLabelData.tooltipRowIndexByFeatureId &&
          getLayerTooltipSignature(config) === (loadedLabelData.tooltipSignature ?? '')
        ) {
          const rowIndex = loadedLabelData.tooltipRowIndexByFeatureId.get(labelId);
          if (rowIndex !== undefined && rowIndex >= 0) {
            const tooltipItems = resolveTooltipItems(
              loadedLabelData.tooltipFields,
              loadedLabelData.tooltipColumns,
              rowIndex
            );
            items.push(...tooltipItems);
          }
        }

        return attachTooltipElementContext(
          {
            title: labelId,
            items,
          },
          elementContext
        );
      }

      if (elem.type !== 'shapes') {
        return undefined;
      }

      const config = layersRef.current[layerId];
      const loadedShapeData = loadedDataRef.current.shapes.get(elem.key);
      const prebuilt = loadedDataRef.current.shapePrebuiltData.get(layerId)?.prebuilt;
      const feature = resolveShapeFeatureFromPick(pickInfo, prebuilt);
      if (!feature) {
        return undefined;
      }

      if (
        loadedShapeData?.tooltipFields &&
        loadedShapeData.tooltipColumns &&
        getLayerTooltipSignature(config) === (loadedShapeData.tooltipSignature ?? '')
      ) {
        const tooltip = resolveShapeTooltipFromPickInfo(
          {
            tooltipFields: loadedShapeData.tooltipFields,
            tooltipColumns: loadedShapeData.tooltipColumns,
          },
          pickInfo,
          {
            tooltipRowIndexByFeatureId: loadedShapeData.tooltipRowIndexByFeatureId,
            tooltipRowIndices: loadedShapeData.tooltipRowIndices,
            rowIndexByFeatureIndex: loadedShapeData.renderData.rowIndexByFeatureIndex,
          },
          prebuilt
        );
        if (tooltip) {
          return attachTooltipElementContext(tooltip, elementContext);
        }
      }

      return attachTooltipElementContext(
        {
          title: feature.featureId,
          items: [{ label: 'feature_id', value: feature.featureId }],
        },
        elementContext
      );
    },
    []
  );

  const getShapePickEvent = useCallback(
    (layerId: string, pickInfo: Pick<{ index?: number; object?: unknown }, 'index' | 'object'>) => {
      const elem = resolveLayerElement(layerId, layersRef.current[layerId], elementMap.current);
      if (!elem || elem.type !== 'shapes') {
        return undefined;
      }
      const feature = resolveShapeFeatureFromPick(
        pickInfo,
        loadedDataRef.current.shapePrebuiltData.get(layerId)?.prebuilt
      );
      if (!feature) {
        return undefined;
      }
      const rowIndex = resolveShapeTooltipRowIndex(feature, {
        tooltipRowIndexByFeatureId: loadedDataRef.current.shapes.get(elem.key)
          ?.tooltipRowIndexByFeatureId,
        tooltipRowIndices: loadedDataRef.current.shapes.get(elem.key)?.tooltipRowIndices,
        rowIndexByFeatureIndex: loadedDataRef.current.shapes.get(elem.key)?.renderData
          .rowIndexByFeatureIndex,
      }) ?? feature.rowIndex;
      return {
        layerId,
        elementKey: elem.key,
        featureId: feature.featureId,
        featureIndex: feature.featureIndex,
        rowIndex,
        object: feature,
      };
    },
    []
  );

  const getVivLayerProps = useCallback((): ImageLayerConfig[] => {
    const vivProps: ImageLayerConfig[] = [];
    const loaded = loadedDataRef.current;

    for (const layerId of layerOrder) {
      const config = layers[layerId];
      if (!config?.visible || config.type !== 'image') continue;

      const elem = resolveLayerElement(layerId, config, elementMap.current);
      if (!elem || elem.type !== 'image') continue;

      const imageData = loaded.images.get(elem.key);
      if (!imageData) continue; // Skip if loader not ready yet

      const ch = config.channels;
      const colors =
        ch?.colors && ch.colors.length > 0 ? ch.colors : imageData.colors || [[255, 255, 255]];
      const contrastLimits =
        ch?.contrastLimits && ch.contrastLimits.length > 0
          ? ch.contrastLimits
          : imageData.contrastLimits || [[0, 65535]];
      const channelsVisible =
        ch?.channelsVisible && ch.channelsVisible.length > 0
          ? ch.channelsVisible
          : imageData.channelsVisible || [true];
      const rawSelections =
        ch?.selections && ch.selections.length > 0 ? ch.selections : imageData.selections || [{}];
      const axisSizes = imageData.selectionAxisSizes;
      const selections =
        axisSizes !== undefined
          ? clampVivSelectionsToAxes(rawSelections, axisSizes)
          : rawSelections;
      const stableSelections = getStableSelections(`image:${layerId}`, selections);

      vivProps.push({
        id: config.id,
        loader: imageData.loader,
        colors,
        contrastLimits,
        channelsVisible,
        selections: stableSelections,
        modelMatrix: elem.transform, // Apply coordinate transformation
        opacity: config.opacity,
        visible: config.visible,
      });
    }

    return vivProps;
  }, [layers, layerOrder, getStableSelections]);

  const isLoading = useMemo(
    () =>
      Object.values(layerLoadStates).some((state) =>
        Object.values(state).some((status) => status === 'loading')
      ),
    [layerLoadStates]
  );

  const isBlocking = useMemo(
    () =>
      layerOrder.some((layerId) => {
        const config = layers[layerId];
        if (!config?.visible) return false;
        const state = layerLoadStates[layerId];
        if (!state) return false;
        if (config.type === 'image') {
          return state.image === 'loading' && !hasRenderableLayerData(layerId);
        }
        if (config.type === 'labels') {
          return state.image === 'loading' && !hasRenderableLayerData(layerId);
        }
        if (config.type === 'shapes' || config.type === 'points') {
          return state.geometry === 'loading' && !hasRenderableLayerData(layerId);
        }
        return false;
      }),
    [layerLoadStates, layerOrder, layers, hasRenderableLayerData]
  );

  return {
    getLayers,
    getVivLayerProps,
    getImageLayerLoadedData,
    getLabelsLayerLoadedData,
    getLayerLoadState,
    hasRenderableLayerData,
    getFeatureTooltip,
    getShapePickEvent,
    isLoading,
    isBlocking,
    reloadElement,
    getWorldBoundsForLayer,
    getWorldBoundsForVisibleLayers,
  };
}
