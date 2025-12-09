import type { Matrix4 } from '@math.gl/core';
import type { SpatialElement, CoordinateSystemNotFoundError } from "../models";
import type { BaseTransformation } from "./transformations";
import type { Result } from "../types";
import { unwrap } from "../types";


export type MappingToCoordinateSystem_t = Map<string, BaseTransformation>;

/**
 * Get the transformation(s) for a given SpatialElement.
 * 
 * This is a convenience wrapper around element.getTransformation() and element.getAllTransformations().
 * For most use cases, prefer calling those methods directly on the element.
 * 
 * @param element - A spatial element (ImageElement, ShapesElement, etc.)
 * @param toCoordinateSystem - Target coordinate system. Defaults to 'global'.
 * @param getAll - If true, return all coordinate system mappings as a Map
 * @returns Result containing the transformation, or a Map of all transformations
 */
export function getTransformation(
  element: SpatialElement,
  toCoordinateSystem?: string,
  getAll?: false
): Result<BaseTransformation, CoordinateSystemNotFoundError>;
export function getTransformation(
  element: SpatialElement,
  toCoordinateSystem: string | undefined,
  getAll: true
): Map<string, BaseTransformation>;
export function getTransformation(
  element: SpatialElement,
  toCoordinateSystem?: string,
  getAll = false
): Result<BaseTransformation, CoordinateSystemNotFoundError> | Map<string, BaseTransformation> {
  if (getAll) {
    return element.getAllTransformations();
  }
  return element.getTransformation(toCoordinateSystem);
}

/**
 * Get a Matrix4 transformation for a spatial element to a target coordinate system.
 * Convenience method for rendering that unwraps the Result and throws on error.
 * 
 * @param element - A spatial element
 * @param toCoordinateSystem - Target coordinate system name (defaults to 'global')
 * @throws CoordinateSystemNotFoundError if the coordinate system is not available
 * @returns A Matrix4 transform
 */
export function getTransformMatrix(
  element: SpatialElement, 
  toCoordinateSystem?: string
): Matrix4 {
  const result = element.getTransformation(toCoordinateSystem);
  return unwrap(result).toMatrix();
}
