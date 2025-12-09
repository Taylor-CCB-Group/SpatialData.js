/**
 * Points layer renderer using deck.gl ScatterplotLayer
 * 
 * Renders point cloud data from SpatialData points elements.
 */

import { ScatterplotLayer } from 'deck.gl';
import type { Matrix4 } from '@math.gl/core';
import type { PointsElement } from '@spatialdata/core';
import type { Layer } from 'deck.gl';

export interface PointDataX {
  position: [number, number] | [number, number, number];
  // Additional properties can be added for coloring, sizing, etc.
  [key: string]: unknown;
}

// this is ndarray and should be defined elsewhere
// not that we wouldn't also want to be able to have other data & accessors
export interface PointData {
  shape: number[];
  data: number[][];
}

export interface PointsLayerRenderConfig {
  /** The points element to render */
  element: PointsElement;
  /** Unique layer ID */
  id: string;
  /** Transformation matrix to target coordinate system */
  modelMatrix: Matrix4;
  /** Layer opacity (0-1) */
  opacity: number;
  /** Whether layer is visible */
  visible: boolean;
  /** Point radius in pixels */
  pointSize?: number;
  /** Point color [r, g, b, a] (0-255) */
  color?: [number, number, number, number];
  /** ndarray - if we want other data for properties like color/radius etc they will be handled differently */
  pointData?: PointData;
}

/**
 * Create a deck.gl ScatterplotLayer for points data.
 * 
 * Note: This requires the point data to be pre-loaded since deck.gl layers
 * are synchronous. The data loading should happen at a higher level.
 */
export function renderPointsLayer(config: PointsLayerRenderConfig): Layer | null {
  const { 
    element, 
    id, 
    modelMatrix, 
    opacity, 
    visible,
    pointSize = 1,
    color = [255, 100, 100, 200],
    pointData,
  } = config;

  if (!visible) return null;
  
  if (!pointData) {
    // Data not loaded yet
    console.debug(`[PointsRenderer] No point data for layer "${id}" from ${element.url}`);
    return null;
  }
  const d = pointData.data;
  return new ScatterplotLayer({
    id,
    data: d[0], //just for index really
    // todo: more robust ndarray handling, be more efficient with target
    // probably more important will be having proper spatial data-structure (quad/oct-tree)
    // with ways of querying within view.
    // also allow accessors for other props
    getPosition: (_d, {index, target}) => [d[0][index], d[1][index], d[2]?.[index]],
    getRadius: pointSize,
    radiusUnits: 'pixels',
    getFillColor: color,
    opacity,
    // Apply coordinate transformation
    modelMatrix,
    // Picking
    pickable: true,
    autoHighlight: true,
    highlightColor: [255, 255, 0, 200],
  });
}

/**
 * Load point data from a points element.
 * This is async and should be called during component setup.
 * 
 * TODO: Implement actual loading from PointsElement
 * Points data is typically stored as a parquet-like columnar format in zarr
 */
export async function loadPointsData(
  element: PointsElement
) {
  // TODO: Implement loading from element
  // Points elements store x, y (and optionally z) coordinates
  // along with other attributes
  console.debug(`[PointsRenderer] Would load points from ${element.url}`);
  return element.loadPoints();
}

