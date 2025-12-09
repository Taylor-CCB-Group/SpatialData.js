/**
 * Shapes layer renderer using deck.gl PolygonLayer
 * 
 * Renders GeoParquet-style polygon/multipolygon data from SpatialData shapes elements.
 */

import { PolygonLayer } from 'deck.gl';
import type { Matrix4 } from '@math.gl/core';
import type { ShapesElement } from '@spatialdata/core';
import type { Layer } from 'deck.gl';

export interface ShapesLayerRenderConfig {
  /** The shapes element to render */
  element: ShapesElement;
  /** Unique layer ID */
  id: string;
  /** Transformation matrix to target coordinate system */
  modelMatrix: Matrix4;
  /** Layer opacity (0-1) */
  opacity: number;
  /** Whether layer is visible */
  visible: boolean;
  /** Fill color [r, g, b, a] (0-255) */
  fillColor?: [number, number, number, number];
  /** Stroke color [r, g, b, a] (0-255) */
  strokeColor?: [number, number, number, number];
  /** Stroke width in pixels */
  strokeWidth?: number;
  /** Pre-loaded polygon data (optional - if not provided, will need to be loaded) */
  polygonData?: Array<Array<Array<[number, number]>>>;
}

/**
 * Create a deck.gl PolygonLayer for shapes data.
 * 
 * Note: This requires the polygon data to be pre-loaded since deck.gl layers
 * are synchronous. The data loading should happen at a higher level.
 */
export function renderShapesLayer(config: ShapesLayerRenderConfig): Layer | null {
  const { 
    element, 
    id, 
    modelMatrix, 
    opacity, 
    visible,
    fillColor = [100, 100, 200, 180],
    strokeColor = [255, 255, 255, 255],
    strokeWidth = 1,
    polygonData,
  } = config;

  if (!visible) return null;
  
  if (!polygonData) {
    // Data not loaded yet
    console.debug(`[ShapesRenderer] No polygon data for layer "${id}" from ${element.url}`);
    return null;
  }

  return new PolygonLayer({
    id,
    data: polygonData,
    // Each item in polygonData is a polygon (array of rings, each ring is array of [x, y])
    getPolygon: (d: Array<Array<[number, number]>>) => d,
    getFillColor: fillColor,
    getLineColor: strokeColor,
    getLineWidth: strokeWidth,
    lineWidthUnits: 'pixels',
    filled: true,
    stroked: true,
    opacity,
    // Apply coordinate transformation
    modelMatrix,
    // Picking
    pickable: true,
    autoHighlight: true,
    highlightColor: [255, 255, 0, 128],
  });
}

/**
 * Load polygon data from a shapes element.
 * This is async and should be called during component setup.
 */
export async function loadShapesData(
  element: ShapesElement
): Promise<Array<Array<Array<[number, number]>>>> {
  try {
    const result = await element.loadPolygonShapes();
    // loadPolygonShapes returns { shape: [n, null], data: polygons[] }
    return result.data;
  } catch (error) {
    console.warn(`[ShapesRenderer] Failed to load shapes from ${element.url}:`, error);
    return [];
  }
}

