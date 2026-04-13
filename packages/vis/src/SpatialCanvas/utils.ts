/**
 * Utility functions for SpatialCanvas
 */

import type { Matrix4 } from '@math.gl/core';
import {
  type AxisAlignedBounds,
  type SpatialData,
  type SpatialElement,
  viewStateFromBounds,
} from '@spatialdata/core';
import type { ElementsByType, LayerType } from './types';

/**
 * Map from SpatialData element property names to layer types
 */
const ELEMENT_TYPE_MAP: Record<string, LayerType> = {
  images: 'image',
  shapes: 'shapes',
  points: 'points',
  labels: 'labels',
};

/**
 * Get all elements from a SpatialData object that have valid transformations
 * to the specified coordinate system.
 */
export function getAvailableElements(
  spatialData: SpatialData,
  coordinateSystem: string
): ElementsByType {
  const result: ElementsByType = {
    images: [],
    shapes: [],
    points: [],
    labels: [],
  };

  const elementTypes = ['images', 'shapes', 'points', 'labels'] as const;

  for (const elementType of elementTypes) {
    const elements = spatialData[elementType];
    if (!elements) continue;

    const layerType = ELEMENT_TYPE_MAP[elementType];

    for (const [key, element] of Object.entries(elements)) {
      // Type assertion needed because TypeScript can't narrow the union
      const spatialElement = element as SpatialElement;
      const transformResult = spatialElement.getTransformation(coordinateSystem);

      if (transformResult.ok) {
        const transform = transformResult.value.toMatrix();
        result[elementType].push({
          key,
          type: layerType,
          element: spatialElement,
          transform,
        });
      }
      // If not ok, element doesn't have a transform to this CS - skip it
    }
  }

  return result;
}

/**
 * Get all unique coordinate systems available across all elements in a SpatialData object.
 */
export function getAllCoordinateSystems(spatialData: SpatialData): string[] {
  return spatialData.coordinateSystems;
}

/**
 * Get the transformation matrix for an element to a target coordinate system.
 * Returns undefined if no transformation exists.
 */
export function getElementTransform(
  element: SpatialElement,
  coordinateSystem: string
): Matrix4 | undefined {
  const result = element.getTransformation(coordinateSystem);
  if (result.ok) {
    return result.value.toMatrix();
  }
  return undefined;
}

/**
 * Generate a unique layer ID for an element
 */
export function generateLayerId(elementType: LayerType, elementKey: string): string {
  return `${elementType}:${elementKey}`;
}

/**
 * Parse a layer ID back to its components
 */
export function parseLayerId(layerId: string): { type: LayerType; key: string } | null {
  const [type, ...keyParts] = layerId.split(':');
  if (!type || keyParts.length === 0) return null;
  return {
    type: type as LayerType,
    key: keyParts.join(':'), // Rejoin in case key contained colons
  };
}

/**
 * Map world-space bounds to an orthographic view state (Viv-compatible zoom).
 */
export function calculateInitialViewState(
  bounds: AxisAlignedBounds | null,
  viewWidth: number,
  viewHeight: number
): { target: [number, number]; zoom: number } {
  if (!bounds) {
    return { target: [0, 0], zoom: 0 };
  }
  return viewStateFromBounds(bounds, viewWidth, viewHeight);
}
