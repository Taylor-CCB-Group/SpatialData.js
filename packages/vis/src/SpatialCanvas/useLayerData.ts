/**
 * Hook for loading and caching layer data
 * 
 * Handles async loading of geometry data (shapes, points) and manages
 * loading state for each layer.
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import type { Matrix4 } from '@math.gl/core';
import type { Layer } from 'deck.gl';
import type { ShapesElement, PointsElement, ImageElement } from '@spatialdata/core';
import type { LayerConfig, ElementsByType, AvailableElement } from './types';
import { 
  renderShapesLayer, 
  loadShapesData,
  type ShapesLayerRenderConfig,
} from './renderers/shapesRenderer';
import { 
  renderPointsLayer, 
  loadPointsData,
  type PointsLayerRenderConfig,
  type PointData,
} from './renderers/pointsRenderer';

interface LoadedData {
  shapes: Map<string, Array<Array<Array<[number, number]>>>>;
  points: Map<string, PointData[]>;
  images: Map<string, unknown>; // Viv loaders - to be implemented
}

interface UseLayerDataResult {
  /** Get deck.gl layers ready for rendering */
  getLayers: () => Layer[];
  /** Whether any layers are currently loading */
  isLoading: boolean;
  /** Trigger a reload of data for a specific element */
  reloadElement: (type: string, key: string) => void;
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
): UseLayerDataResult {
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
        if (config.type === 'shapes' && !loaded.shapes.has(elem.key)) {
          toLoad.push({ layerId, element: elem });
        } else if (config.type === 'points' && !loaded.points.has(elem.key)) {
          toLoad.push({ layerId, element: elem });
        }
        // Images handled separately (Viv loader)
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
            const data = await loadShapesData(element.element as ShapesElement);
            loadedDataRef.current.shapes.set(element.key, data);
          } else if (element.type === 'points') {
            // todo better type-guards etc here.
            const e = element.element as PointsElement;
            const data = await e.loadPoints();
            //@ts-expect-error todo review how PointData type is defined & returned in VPointsSource.ts
            loadedDataRef.current.points.set(element.key, data);
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
  }, [layers, layerOrder]);

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
        const polygonData = loaded.shapes.get(elem.key);
        if (polygonData) {
          const layer = renderShapesLayer({
            element: elem.element as ShapesElement,
            id: layerId,
            modelMatrix: elem.transform,
            opacity: config.opacity,
            visible: config.visible,
            fillColor: config.fillColor,
            strokeColor: config.strokeColor,
            strokeWidth: config.strokeWidth,
            polygonData,
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
      // Image layers need Viv integration - skip for now
    }
    
    return deckLayers;
  }, [layers, layerOrder]);

  return {
    getLayers,
    isLoading: loadingKeys.size > 0,
    reloadElement,
  };
}

