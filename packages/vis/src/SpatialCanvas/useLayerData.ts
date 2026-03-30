/**
 * Hook for loading and caching layer data
 * 
 * Handles async loading of geometry data (shapes, points) and manages
 * loading state for each layer.
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import type { Matrix4 } from '@math.gl/core';
import type { Layer } from 'deck.gl';
import type { ShapesElement, PointsElement, ImageElement, SpatialData } from '@spatialdata/core';
import {
  buildDefaultSelection,
  clampVivSelectionsToAxes,
  getMultiSelectionStats,
  getVivSelectionAxisSizes,
  guessRgb,
  isInterleaved,
  COLOR_PALLETE,
  tryParseOmeroHexColor,
} from '@spatialdata/avivatorish';
import type { LayerConfig, ElementsByType, AvailableElement } from './types';
import { 
  renderShapesLayer, 
  loadShapesData,
  type ShapeTooltipDatum,
} from './renderers/shapesRenderer';
import { 
  renderPointsLayer, 
  type PointsLayerRenderConfig,
  type PointData,
} from './renderers/pointsRenderer';
import { createImageLoader } from './renderers/imageRenderer';
import { useVivLoaderRegistry } from './VivLoaderRegistry';
import { applyPerChannelFallbackWithoutOmero, type VivLoaderMetadata } from './imageLoaderChannelDefaults';

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
  shapeIds?: string[];
  tooltipSignature?: string;
  tooltipFields?: string[];
  tooltipColumns?: Array<string[] | undefined>;
  /**
   * Optional row-index lookup aligned to polygon order.
   * When omitted, polygon index and tooltip row index are assumed to be identical.
   * A value of -1 indicates no matching tooltip row for that shape.
   */
  tooltipRowIndices?: Int32Array;
}

interface LoadedData {
  shapes: Map<string, LoadedShapesData>;
  points: Map<string, PointData>;
  images: Map<string, ImageLoaderData>; // Viv loaders with computed channel data
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

interface UseLayerDataResult {
  /** Get deck.gl layers ready for rendering (shapes, points, etc.) */
  getLayers: () => Layer[];
  /** Get Viv layer props for image layers */
  getVivLayerProps: () => ImageLayerConfig[];
  /** Raw loaded image pipeline data (defaults) for the properties UI */
  getImageLayerLoadedData: (layerId: string) => ImageLoaderData | undefined;
  /** Resolve a shapes tooltip lazily from the picked row index. */
  getShapeTooltip: (layerId: string, objectIndex: number) => ShapeTooltipDatum | undefined;
  /** Whether any layers are currently loading */
  isLoading: boolean;
  /** Trigger a reload of data for a specific element */
  reloadElement: (type: string, key: string) => void;
}

function getTooltipSignature(config: LayerConfig | undefined): string {
  if (!config || config.type !== 'shapes') {
    return '';
  }
  return (config.tooltipFields ?? []).join('\u0001');
}

function normalizeTooltipValue(value: string[] | undefined, rowIndex: number): string {
  if (!value) return '';
  const row = value[rowIndex];
  return row ?? '';
}

function tableRegionMatches(regionValue: string, shapeKey: string) {
  return regionValue === shapeKey || regionValue === `shapes/${shapeKey}`;
}

async function loadShapeTooltipData(
  spatialData: SpatialData | undefined,
  element: ShapesElement,
  tooltipFields: string[],
): Promise<
  Pick<
    LoadedShapesData,
    'shapeIds' | 'tooltipSignature' | 'tooltipFields' | 'tooltipColumns' | 'tooltipRowIndices'
  >
> {
  const tooltipSignature = tooltipFields.join('\u0001');
  const shapeIdsRaw = await element.loadShapesIndex();
  const shapeIds = shapeIdsRaw ? Array.from(shapeIdsRaw, (value: unknown) => String(value)) : undefined;

  if (!shapeIds || !spatialData || tooltipFields.length === 0) {
    return { shapeIds, tooltipSignature, tooltipFields };
  }

  const associated = spatialData.getAssociatedTable('shapes', element.key);
  if (!associated) {
    return { shapeIds, tooltipSignature };
  }

  const [, table] = associated;
  const { regionKey } = table.getTableKeys();
  const requestedColumns = Array.from(new Set([regionKey, ...tooltipFields]));
  const rowIds = await table.loadObsIndex();
  const columns = await table.loadObsColumns(requestedColumns);
  const regionColumn = columns[0];
  const tooltipColumns = columns.slice(1);
  const filteredRowIds: string[] = [];
  const filteredRowIndices: number[] = [];

  for (const [rowIndex, rowId] of rowIds.entries()) {
    const regionValue = normalizeTooltipValue(regionColumn, rowIndex);
    if (regionValue && !tableRegionMatches(regionValue, element.key)) {
      continue;
    }
    filteredRowIds.push(String(rowId));
    filteredRowIndices.push(rowIndex);
  }

  let tooltipRowIndices: Int32Array | undefined;
  const isDirectlyAligned =
    filteredRowIds.length === shapeIds.length
    && filteredRowIds.every((rowId, index) => rowId === shapeIds[index]);

  if (!isDirectlyAligned) {
    const rowIndexByShapeId = new Map<string, number>();
    for (const [index, rowId] of filteredRowIds.entries()) {
      rowIndexByShapeId.set(rowId, filteredRowIndices[index]);
    }

    tooltipRowIndices = new Int32Array(shapeIds.length);
    tooltipRowIndices.fill(-1);
    for (const [shapeIndex, shapeId] of shapeIds.entries()) {
      const matchedRowIndex = rowIndexByShapeId.get(shapeId);
      if (matchedRowIndex !== undefined) {
        tooltipRowIndices[shapeIndex] = matchedRowIndex;
      }
    }
  }

  return {
    shapeIds,
    tooltipSignature,
    tooltipFields,
    tooltipColumns,
    tooltipRowIndices,
  };
}

async function loadShapesLayerData(
  spatialData: SpatialData | undefined,
  element: ShapesElement,
  config: LayerConfig | undefined,
): Promise<LoadedShapesData> {
  const polygons = await loadShapesData(element);
  const tooltipFields =
    config?.type === 'shapes'
      ? config.tooltipFields ?? []
      : [];
  const tooltipData = await loadShapeTooltipData(spatialData, element, tooltipFields);
  return {
    polygons,
    ...tooltipData,
  };
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
  spatialData?: SpatialData,
): UseLayerDataResult {
  const { getOmeZarrMultiscalesData } = useVivLoaderRegistry();

  // Cache for loaded data
  const loadedDataRef = useRef<LoadedData>({
    shapes: new Map(),
    points: new Map(),
    images: new Map(),
  });

  // Track which elements are currently loading
  const [loadingKeys, setLoadingKeys] = useState<Set<string>>(new Set());

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

  // Load data for enabled layers that don't have data yet
  useEffect(() => {
    const loadData = async () => {
      const toLoad: Array<{ layerId: string; element: AvailableElement }> = [];
      
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
          if (!loadedShapes || loadedShapes.tooltipSignature !== tooltipSignature) {
            toLoad.push({ layerId, element: elem });
          }
        } else if (config.type === 'points' && !loaded.points.has(elem.key)) {
          toLoad.push({ layerId, element: elem });
        } else if (config.type === 'image' && !loaded.images.has(elem.key)) {
          toLoad.push({ layerId, element: elem });
        }
      }
      
      if (toLoad.length === 0) return;
      
      // Mark as loading
      setLoadingKeys(prev => {
        const next = new Set(prev);
        for (const { layerId } of toLoad) next.add(layerId);
        return next;
      });
      
      // Load in parallel
      await Promise.all(toLoad.map(async ({ layerId, element }) => {
        try {
          if (element.type === 'shapes') {
            const data = await loadShapesLayerData(
              spatialData,
              element.element as ShapesElement,
              layers[layerId],
            );
            loadedDataRef.current.shapes.set(element.key, data);
          } else if (element.type === 'points') {
            // todo better type-guards etc here.
            const e = element.element as PointsElement;
            const data = await e.loadPoints();
            loadedDataRef.current.points.set(element.key, data);
          } else if (element.type === 'image') {
            const loader = await createImageLoader(
              element.element as ImageElement,
              getOmeZarrMultiscalesData,
            );
            // Compute channel defaults from loader metadata
            const imageElement = element.element as ImageElement;
            const loaderToCheck = Array.isArray(loader) ? loader[0] : loader;
            
            const imageData: ImageLoaderData = { loader };
            
            try {
              if (loaderToCheck && typeof loaderToCheck === 'object' && 'labels' in loaderToCheck && 'shape' in loaderToCheck) {
                const loaderObj = loaderToCheck as VivLoaderMetadata;
                imageData.selectionAxisSizes = getVivSelectionAxisSizes(loaderObj.labels, loaderObj.shape);
                
                // Build selections
                const selections = buildDefaultSelection({
                  labels: loaderObj.labels,
                  shape: loaderObj.shape,
                });
                
                // Get metadata from image element
                const metadata = imageElement.attrs.omero;
                
                if (metadata?.channels) {
                  const Channels = metadata.channels;
                  const isRgb = guessRgb({ Pixels: { Channels: Channels.map((c: any) => ({ Name: c.label })) } } as any);
                  
                  if (isRgb) {
                    if (isInterleaved(loaderObj.shape)) {
                      imageData.contrastLimits = [[0, 255]];
                      imageData.colors = [[255, 0, 0]];
                    } else {
                      imageData.contrastLimits = [[0, 255], [0, 255], [0, 255]];
                      imageData.colors = [[255, 0, 0], [0, 255, 0], [0, 0, 255]];
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
                loaderToCheck && typeof loaderToCheck === 'object' && 'labels' in loaderToCheck && 'shape' in loaderToCheck
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
                  applyPerChannelFallbackWithoutOmero(imageData, fallbackLoader, fallbackSelections);
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
          }
        } catch (error) {
          console.error(`Failed to load data for ${layerId}:`, error);
        } finally {
          setLoadingKeys(prev => {
            const next = new Set(prev);
            next.delete(layerId);
            return next;
          });
        }
      }));
    };
    
    loadData();
  }, [layers, layerOrder, getOmeZarrMultiscalesData, spatialData]);

  const reloadElement = useCallback((type: string, key: string) => {
    const loaded = loadedDataRef.current;
    if (type === 'shapes') {
      loaded.shapes.delete(key);
    } else if (type === 'points') {
      loaded.points.delete(key);
    } else if (type === 'image') {
      loaded.images.delete(key);
    }
    // The useEffect will pick up the missing data and reload
  }, []);

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

  const getShapeTooltip = useCallback((layerId: string, objectIndex: number): ShapeTooltipDatum | undefined => {
    const elem = elementMap.current.get(layerId);
    if (!elem || elem.type !== 'shapes') {
      return undefined;
    }

    const loadedShapeData = loadedDataRef.current.shapes.get(elem.key);
    if (!loadedShapeData?.shapeIds || !loadedShapeData.tooltipFields || !loadedShapeData.tooltipColumns) {
      return undefined;
    }

    const shapeId = loadedShapeData.shapeIds[objectIndex];
    if (!shapeId) {
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
      title: shapeId,
      items,
    };
  }, []);

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
        ch?.colors && ch.colors.length > 0
          ? ch.colors
          : (imageData.colors || [[255, 255, 255]]);
      const contrastLimits =
        ch?.contrastLimits && ch.contrastLimits.length > 0
          ? ch.contrastLimits
          : (imageData.contrastLimits || [[0, 65535]]);
      const channelsVisible =
        ch?.channelsVisible && ch.channelsVisible.length > 0
          ? ch.channelsVisible
          : (imageData.channelsVisible || [true]);
      const rawSelections =
        ch?.selections && ch.selections.length > 0
          ? ch.selections
          : (imageData.selections || [{}]);
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

  return {
    getLayers,
    getVivLayerProps,
    getImageLayerLoadedData,
    getShapeTooltip,
    isLoading: loadingKeys.size > 0,
    reloadElement,
  };
}
