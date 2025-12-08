import type { Matrix4 } from '@math.gl/core';
import type { SpatialElement } from "../models";
import { Identity, type BaseTransformation, parseTransforms } from "./transformations";


const DEFAULT_COORDINATE_SYSTEM = 'global';

export type MappingToCoordinateSystem_t = Map<string, BaseTransformation>;

/**
 * Get the transformation(s) for a given SpatialElement.
 * 
 * Uses the element's getAllTransformations() method to retrieve coordinate system mappings.
 * Transformations are stored at the element level with input/output coordinate system refs.
 */
export function getTransformation(
  element: SpatialElement,
  toCoordinateSystem?: string,
  getAll?: false
): BaseTransformation;
export function getTransformation(
  element: SpatialElement,
  toCoordinateSystem: string | undefined,
  getAll: true
): Map<string, BaseTransformation>;
export function getTransformation(
  element: SpatialElement,
  toCoordinateSystem?: string,
  getAll = false
): BaseTransformation | Map<string, BaseTransformation> {
  
  // Use the element's getAllTransformations method
  const allTransforms = element.getAllTransformations();
  
  if (allTransforms.size === 0) {
    // No coordinate systems defined - return identity
    if (getAll) {
      const map = new Map<string, BaseTransformation>();
      map.set(DEFAULT_COORDINATE_SYSTEM, new Identity());
      return map;
    }
    return new Identity();
  }
  
  if (getAll) {
    // Return all coordinate system mappings, parsed into BaseTransformation instances
    const map = new Map<string, BaseTransformation>();
    for (const [csName, coordTransforms] of allTransforms.entries()) {
      map.set(csName, parseTransforms(coordTransforms));
    }
    return map;
  }
  
  // Get transformation for a specific coordinate system
  const targetCS = toCoordinateSystem ?? DEFAULT_COORDINATE_SYSTEM;
  const coordTransforms = allTransforms.get(targetCS);
  
  if (coordTransforms) {
    return parseTransforms(coordTransforms);
  }
  
  // Fallback: return first available transform or identity
  const firstEntry = allTransforms.entries().next();
  if (!firstEntry.done) {
    return parseTransforms(firstEntry.value[1]);
  }
  
  return new Identity();
}

/**
 * Get a Matrix4 transformation for a spatial element to a target coordinate system.
 * This is the preferred method for getting transforms for rendering.
 * 
 * @param element - A spatial element
 * @param toCoordinateSystem - Target coordinate system name (defaults to 'global')
 * @returns A Matrix4 transform, or identity matrix if no transforms defined
 */
export function getTransformMatrix(
  element: SpatialElement, 
  toCoordinateSystem?: string
): Matrix4 {
  const transform = getTransformation(element, toCoordinateSystem, false);
  return transform.toMatrix();
}
