import { Matrix4 } from '@math.gl/core';
import type { SpatialElement } from "../models";
import { Identity, type BaseTransformation, buildMatrix4FromTransforms } from "./transformations";
import type { CoordinateTransformation } from "../schemas";


const DEFAULT_COORDINATE_SYSTEM = 'global';

export type MappingToCoordinateSytem_t = Map<string, BaseTransformation>;

/**
 * Get the transformation(s) for a given SpatialElement.
 * 
 * Uses the element's getAllTransformations() method to retrieve coordinate system mappings.
 * Transformations are stored at the element level with input/output coordinate system refs.
 * 
 * @param element - A spatial element (ImageElement, ShapesElement, etc.)
 * @param toCoordinateSystem - Target coordinate system. If undefined, returns transforms for all coordinate systems.
 * @param getAll - If true, return all coordinate system mappings as a Map
 * @returns A single transformation, a Map of coordinate systems to transformations, or undefined
 */
export function getTransformation(
  element: SpatialElement, 
  toCoordinateSystem?: string, 
  getAll = false
): BaseTransformation | Map<string, BaseTransformation> | undefined {
  
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
    // Return all coordinate system mappings (as Identity for now - TODO: convert properly)
    const map = new Map<string, BaseTransformation>();
    for (const csName of allTransforms.keys()) {
      // TODO: Convert CoordinateTransformation to BaseTransformation properly
      map.set(csName, new Identity());
    }
    return map;
  }
  
  // Get transformation for a specific coordinate system
  const targetCS = toCoordinateSystem ?? DEFAULT_COORDINATE_SYSTEM;
  if (allTransforms.has(targetCS)) {
    // TODO: Convert CoordinateTransformation to BaseTransformation
    // For now return Identity
    return new Identity();
  }
  
  // Fallback: return first available transform or identity
  if (allTransforms.size > 0) {
    return new Identity();
  }
  
  return new Identity();
}

/**
 * Get a Matrix4 transformation for a spatial element to a target coordinate system.
 * This is the preferred method for getting transforms for rendering.
 * 
 * @param element - A spatial element
 * @param toCoordinateSystem - Target coordinate system name
 * @returns A Matrix4 transform, or identity matrix if no transforms defined
 */
export function getTransformMatrix(
  element: SpatialElement, 
  toCoordinateSystem?: string
): Matrix4 {
  const transforms = element.getTransformations(toCoordinateSystem);
  
  if (!transforms) {
    return new Matrix4().identity();
  }
  
  return buildMatrix4FromTransforms(transforms);
}
