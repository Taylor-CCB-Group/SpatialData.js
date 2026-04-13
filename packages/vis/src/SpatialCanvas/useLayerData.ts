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
  type PointsElement,
  type ShapesElement,
  type SpatialData,
  type TableColumnData,
  boundsFromImagePixelExtents,
  boundsFromPoints,
  boundsFromPolygons,
  getPhysicalSizeScalingMatrixFromMeta,
  unionBoundsList,
} from '@spatialdata/core';
import type { Layer } from 'deck.gl';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useVivLoaderRegistry } from './VivLoaderRegistry';
import {
  type VivLoaderMetadata,
  applyPerChannelFallbackWithoutOmero,
} from './imageLoaderChannelDefaults';
import { createImageLoader } from './renderers/imageRenderer';
import {
  type PointData,
  type PointsLayerRenderConfig,
  renderPointsLayer,
} from './renderers/pointsRenderer';
import { renderLabelsLayer } from './renderers/labelsRenderer';
import {
  type ShapeTooltipDatum,
  loadShapesData,
  renderShapesLayer,
} from './renderers/shapesRenderer';
import type { AvailableElement, ElementsByType, LayerConfig } from './types';

export interface ImageLoaderData {
  loader: unknown;
  colors?: [number, number, number][];
  contrastLimits?: [number, number][];
  channelsVisible?: boolean[];
  selections?: Array<Partial<{ z: number; c: number; t: number }>>;
  /** Present when loader exposes `labels` / `shape`: dimension lengths for z, c, t (omit axes that do not exist). */
  selectionAxisSizes?: Partial<Record<'z' | 'c' | 't', number>>;
}

interface LoadedShapesData {
  polygons: Array<Array<Array<[number, number]>>>;
  featureIds?: string[];
  tooltipSignature?: string;
  tooltipFields?: string[];
  tooltipColumns?: Array<TableColumnData | undefined>;
  /**
   * Optional row-index lookup aligned to picked feature order.
   * When omitted, picked feature index and tooltip row index are assumed to be identical.
   * A value of -1 indicates no matching tooltip row for that feature.
   */
  tooltipRowIndices?: Int32Array;
}

interface LoadedData {
  shapes: Map<string, LoadedShapesData>;
  points: Map<string, PointData>;
  images: Map<string, ImageLoaderData>; // Viv loaders with computed channel data
  labels: Map<string, LabelsLoaderData>;
}

type ResourceLoadStatus = 'idle' | 'loading' | 'ready' | 'error';

export interface LayerLoadState {
  geometry?: ResourceLoadStatus;
  image?: ResourceLoadStatus;
  tooltip?: ResourceLoadStatus;
}

export interface ImageLayerConfig {
  loader: unknown; // Viv PixelSource
  colors: [number, number, number][];
  contrastLimits: [number, number][];
  channelsVisible: boolean[];
  selections: Array<Partial<{ z: number; c: number; t: number }>>;
  modelMatrix?: Matrix4; // Transformation matrix for coordinate system alignment
  opacity?: number; // Layer opacity (0-1)
  visible?: boolean; // Whether layer is visible
}

export interface LabelsLoaderData {
  loader: unknown;
  colors: [number, number, number][];
  channelsVisible: boolean[];
  channelOpacities: number[];
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
  /** Current load state for a given layer. */
  getLayerLoadState: (layerId?: string) => LayerLoadState | undefined;
  /** Whether a layer already has enough data to render. */
  hasRenderableLayerData: (layerId: string) => boolean;
  /** Resolve a feature tooltip lazily from the picked row index. */
  getFeatureTooltip: (layerId: string, objectIndex: number) => ShapeTooltipDatum | undefined;
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

function getTooltipSignature(config: LayerConfig | undefined): string {
  if (!config || config.type !== 'shapes') {
    return '';
  }
  return (config.tooltipFields ?? []).join('\u0001');
}

function normalizeTooltipValue(value: TableColumnData | undefined, rowIndex: number): string {
  if (!value) return '';
  const row = value[rowIndex];
  if (row === null || row === undefined) return '';
  return String(row);
}

function tableRegionMatches(regionValue: string, shapeKey: string) {
  return regionValue === shapeKey || regionValue === `shapes/${shapeKey}`;
}

async function loadShapeTooltipData(
  spatialData: SpatialData | undefined,
  element: ShapesElement,
  tooltipFields: string[]
): Promise<
  Pick<
    LoadedShapesData,
    'featureIds' | 'tooltipSignature' | 'tooltipFields' | 'tooltipColumns' | 'tooltipRowIndices'
  >
> {
  const featureIdsRaw = await element.loadFeatureIds();
  const featureIds = featureIdsRaw
    ? Array.from(featureIdsRaw, (value: unknown) => String(value))
    : undefined;

  if (tooltipFields.length === 0) {
    return {
      featureIds,
      tooltipSignature: '',
      tooltipFields: [],
      tooltipColumns: undefined,
      tooltipRowIndices: undefined,
    };
  }

  if (!featureIds) {
    return {
      featureIds,
      tooltipSignature: undefined,
      tooltipFields,
      tooltipColumns: undefined,
      tooltipRowIndices: undefined,
    };
  }

  if (!spatialData) {
    return {
      featureIds,
      tooltipSignature: undefined,
      tooltipFields,
      tooltipColumns: undefined,
      tooltipRowIndices: undefined,
    };
  }

  const associated = spatialData.getAssociatedTable('shapes', element.key);
  if (!associated) {
    return {
      featureIds,
      tooltipSignature: undefined,
      tooltipFields,
      tooltipColumns: undefined,
      tooltipRowIndices: undefined,
    };
  }

  const tooltipSignature = tooltipFields.join('\u0001');
  const [, table] = associated;
  const { regionKey } = table.getTableKeys();
  const requestedColumns = Array.from(new Set([regionKey, ...tooltipFields]));
  const rowIds = await table.loadObsIndex();
  const columns = await table.loadObsColumns(requestedColumns);
  const regionColumn = columns[0];
  const tooltipColumns = columns.slice(1);
  // I don't like the look of this... creating 0-length arrays then pushing data...
  const filteredRowIds: string[] = [];
  const filteredRowIndices: number[] = [];

  for (let rowIndex = 0; rowIndex < rowIds.length; rowIndex++) {
    const rowId = rowIds[rowIndex];
    const regionValue = normalizeTooltipValue(regionColumn, rowIndex);
    if (regionValue && !tableRegionMatches(regionValue, element.key)) {
      continue;
    }
    filteredRowIds.push(String(rowId));
    filteredRowIndices.push(rowIndex);
  }
  let tooltipRowIndices: Int32Array | undefined;
  // this looks costly?
  const isDirectlyAligned =
    filteredRowIds.length === featureIds.length &&
    filteredRowIds.every((rowId, index) => rowId === featureIds[index]);

  if (!isDirectlyAligned) {
    const rowIndexByFeatureId = new Map<string, number>();
    for (const [index, rowId] of filteredRowIds.entries()) {
      rowIndexByFeatureId.set(rowId, filteredRowIndices[index]);
    }

    tooltipRowIndices = new Int32Array(featureIds.length);
    tooltipRowIndices.fill(-1);
    for (const [featureIndex, featureId] of featureIds.entries()) {
      const matchedRowIndex = rowIndexByFeatureId.get(featureId);
      if (matchedRowIndex !== undefined) {
        tooltipRowIndices[featureIndex] = matchedRowIndex;
      }
    }
  }

  return {
    featureIds,
    tooltipSignature,
    tooltipFields,
    tooltipColumns,
    tooltipRowIndices,
  };
}

async function loadShapesLayerData(
  element: ShapesElement
): Promise<Pick<LoadedShapesData, 'polygons'>> {
  const polygons = await loadShapesData(element);
  return { polygons };
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
  });

  const layersRef = useRef(layers);
  layersRef.current = layers;

  const [layerLoadStates, setLayerLoadStates] = useState<Record<string, LayerLoadState>>({});

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
      const toLoad: Array<{
        layerId: string;
        element: AvailableElement;
        loadGeometry: boolean;
        loadTooltip: boolean;
        loadImage: boolean;
        loadPoints: boolean;
        loadLabels: boolean;
      }> = [];

      for (const layerId of layerOrder) {
        const config = layers[layerId];
        if (!config?.visible) continue;

        const elem = elementMap.current.get(layerId);
        if (!elem) continue;

        // Check if we need to load data
        const loaded = loadedDataRef.current;
        if (config.type === 'shapes') {
          const loadedShapes = loaded.shapes.get(elem.key);
          const tooltipSignature = getTooltipSignature(config);
          const loadGeometry = !loadedShapes;
          const loadTooltip = !loadedShapes || loadedShapes.tooltipSignature !== tooltipSignature;
          if (loadGeometry || loadTooltip) {
            toLoad.push({
              layerId,
              element: elem,
              loadGeometry,
              loadTooltip,
              loadImage: false,
              loadPoints: false,
              loadLabels: false,
            });
          }
        } else if (config.type === 'points' && !loaded.points.has(elem.key)) {
          toLoad.push({
            layerId,
            element: elem,
            loadGeometry: false,
            loadTooltip: false,
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
            loadImage: true,
            loadPoints: false,
            loadLabels: false,
          });
        } else if (config.type === 'labels' && !loaded.labels.has(elem.key)) {
          toLoad.push({
            layerId,
            element: elem,
            loadGeometry: false,
            loadTooltip: false,
            loadImage: false,
            loadPoints: false,
            loadLabels: true,
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
                  const requestedSignature = getTooltipSignature(shapeLayerConfig);
                  if (tooltipFields.length > 0) {
                    setLayerResourceStatus(layerId, 'tooltip', 'loading');
                    const current = loadedDataRef.current.shapes.get(element.key);
                    const tooltipData = await loadShapeTooltipData(
                      spatialData,
                      element.element as ShapesElement,
                      tooltipFields
                    );
                    const latestDesired = getTooltipSignature(
                      layersRef.current[layerId]?.type === 'shapes'
                        ? layersRef.current[layerId]
                        : undefined
                    );
                    if (latestDesired !== requestedSignature) {
                      return;
                    }
                    loadedDataRef.current.shapes.set(element.key, {
                      ...current,
                      ...tooltipData,
                    } as LoadedShapesData);
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
                    } as LoadedShapesData);
                    setLayerResourceStatus(layerId, 'tooltip', 'idle');
                  }
                } catch (error) {
                  setLayerResourceStatus(layerId, 'tooltip', 'error');
                  console.error(`Failed to load shapes tooltip for ${layerId}:`, error);
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
                      } as any);

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
                          loader: loader as any,
                          selections: selections as any,
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
            } else if (element.type === 'labels' && loadLabels) {
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
                  channelOpacities: [1],
                  channelsFilled: [true],
                  channelStrokeWidths: [1],
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
                  ).slice(0, 7);
                  const channelCount = Math.max(selections.length, 1);
                  const metadataChannels = (element.element as LabelsElement).attrs.omero?.channels;

                  const colors = Array.from(
                    { length: channelCount },
                    (_, index): [number, number, number] => {
                      const rgb = tryParseOmeroHexColor(metadataChannels?.[index]?.color);
                      const palette = COLOR_PALLETE[index % COLOR_PALLETE.length];
                      return rgb ?? [palette[0], palette[1], palette[2]];
                    }
                  );
                  labelsData.selectionAxisSizes = axisSizes;
                  labelsData.selections = selections.length > 0 ? selections : [{}];
                  labelsData.colors = colors;
                  labelsData.channelsVisible = colors.map(
                    (_, index) => metadataChannels?.[index]?.active ?? true
                  );
                  labelsData.channelOpacities = colors.map(() => 1);
                  labelsData.channelsFilled = colors.map(() => true);
                  labelsData.channelStrokeWidths = colors.map(() => 1);
                }

                loadedDataRef.current.labels.set(element.key, labelsData);
                setLayerResourceStatus(layerId, 'image', 'ready');
              } catch (error) {
                setLayerResourceStatus(layerId, 'image', 'error');
                console.error(`Failed to load labels for ${layerId}:`, error);
              }
            }
          }
        )
      );
    };

    loadData();
  }, [layers, layerOrder, getOmeZarrMultiscalesData, spatialData, setLayerResourceStatus]);

  const reloadElement = useCallback((type: string, key: string) => {
    const loaded = loadedDataRef.current;
    if (type === 'shapes') {
      loaded.shapes.delete(key);
    } else if (type === 'points') {
      loaded.points.delete(key);
    } else if (type === 'image') {
      loaded.images.delete(key);
    } else if (type === 'labels') {
      loaded.labels.delete(key);
    }
    // The useEffect will pick up the missing data and reload
  }, []);

  const hasRenderableLayerData = useCallback((layerId: string): boolean => {
    const elem = elementMap.current.get(layerId);
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
        const elem = elementMap.current.get(layerId);
        if (!config?.visible || !elem) return null;
        const loaded = loadedDataRef.current;
        if (elem.type === 'shapes') {
          const shapeData = loaded.shapes.get(elem.key);
          if (!shapeData?.polygons?.length) return null;
          return boundsFromPolygons(shapeData.polygons, elem.transform);
        }
        if (elem.type === 'points') {
          const pointData = loaded.points.get(elem.key);
          if (!pointData) return null;
          return boundsFromPoints(pointData, elem.transform, false);
        }
        if (elem.type === 'image') {
          const imageData = loaded.images.get(elem.key);
          if (!imageData?.loader) return null;
          const source = Array.isArray(imageData.loader) ? imageData.loader[0] : imageData.loader;
          if (!source || typeof source !== 'object') return null;
          const { width, height } = getImageSize(source as never);
          const physical = getPhysicalSizeScalingMatrixFromMeta(source);
          return boundsFromImagePixelExtents(width, height, elem.transform, physical);
        }
        if (elem.type === 'labels') {
          const labelsData = loaded.labels.get(elem.key);
          if (!labelsData?.loader) return null;
          const source =
            Array.isArray(labelsData.loader) ? labelsData.loader[0] : labelsData.loader;
          if (!source || typeof source !== 'object') return null;
          const { width, height } = getImageSize(source as never);
          const physical = getPhysicalSizeScalingMatrixFromMeta(source);
          return boundsFromImagePixelExtents(width, height, elem.transform, physical);
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

      const elem = elementMap.current.get(layerId);
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
            polygonData: shapeData.polygons,
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

          const layer = renderLabelsLayer({
            id: layerId,
            loader: labelsData.loader,
            modelMatrix: elem.transform,
            opacity: config.opacity,
            visible: config.visible,
            channelColors:
              ch?.colors && ch.colors.length > 0 ? ch.colors : labelsData.colors,
            channelsVisible:
              ch?.channelsVisible && ch.channelsVisible.length > 0
                ? ch.channelsVisible
                : labelsData.channelsVisible,
            channelOpacities:
              ch?.channelOpacities && ch.channelOpacities.length > 0
                ? ch.channelOpacities
                : labelsData.channelOpacities,
            channelsFilled:
              ch?.channelsFilled && ch.channelsFilled.length > 0
                ? ch.channelsFilled
                : labelsData.channelsFilled,
            channelStrokeWidths:
              ch?.channelStrokeWidths && ch.channelStrokeWidths.length > 0
                ? ch.channelStrokeWidths
                : labelsData.channelStrokeWidths,
            selections,
          });
          if (layer) deckLayers.push(layer);
        }
      }
      // Image layers are handled separately via getVivLayerProps()
    }

    return deckLayers;
  }, [layers, layerOrder]);

  const getImageLayerLoadedData = useCallback((layerId: string): ImageLoaderData | undefined => {
    const elem = elementMap.current.get(layerId);
    if (!elem || elem.type !== 'image') return undefined;
    return loadedDataRef.current.images.get(elem.key);
  }, []);

  const getLayerLoadState = useCallback(
    (layerId?: string): LayerLoadState | undefined => {
      if (layerId === undefined) return undefined;
      return layerLoadStates[layerId];
    },
    [layerLoadStates]
  );

  const getFeatureTooltip = useCallback(
    (layerId: string, objectIndex: number): ShapeTooltipDatum | undefined => {
      const elem = elementMap.current.get(layerId);
      if (!elem || elem.type !== 'shapes') {
        return undefined;
      }

      const loadedShapeData = loadedDataRef.current.shapes.get(elem.key);
      if (
        !loadedShapeData?.featureIds ||
        !loadedShapeData.tooltipFields ||
        !loadedShapeData.tooltipColumns
      ) {
        return undefined;
      }

      const config = layersRef.current[layerId];
      if (getTooltipSignature(config) !== (loadedShapeData.tooltipSignature ?? '')) {
        return undefined;
      }

      const featureId = loadedShapeData.featureIds[objectIndex];
      if (!featureId) {
        return undefined;
      }

      const rowIndex = loadedShapeData.tooltipRowIndices
        ? loadedShapeData.tooltipRowIndices[objectIndex]
        : objectIndex;
      if (rowIndex === undefined || rowIndex < 0) {
        return undefined;
      }

      const items = loadedShapeData.tooltipFields
        .map((field, fieldIndex) => ({
          label: field,
          value: normalizeTooltipValue(loadedShapeData.tooltipColumns?.[fieldIndex], rowIndex),
        }))
        .filter((item) => item.value !== '');

      if (items.length === 0) {
        return undefined;
      }

      return {
        title: featureId,
        items,
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

      const elem = elementMap.current.get(layerId);
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

      vivProps.push({
        loader: imageData.loader,
        colors,
        contrastLimits,
        channelsVisible,
        selections,
        modelMatrix: elem.transform, // Apply coordinate transformation
        opacity: config.opacity,
        visible: config.visible,
      });
    }

    return vivProps;
  }, [layers, layerOrder]);

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
    getLayerLoadState,
    hasRenderableLayerData,
    getFeatureTooltip,
    isLoading,
    isBlocking,
    reloadElement,
    getWorldBoundsForLayer,
    getWorldBoundsForVisibleLayers,
  };
}
