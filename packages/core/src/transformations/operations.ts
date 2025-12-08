import { Matrix4 } from '@math.gl/core';
import type { SpatialElement } from "../models";
import { Identity, type BaseTransformation, buildMatrix4FromTransforms } from "./transformations";
import type { CoordinateTransformation } from "../schemas";


const DEFAULT_COORDINATE_SYSTEM = 'global';

export type MappingToCoordinateSytem_t = Map<string, BaseTransformation>;

/**
 * Get the transformation(s) for a given SpatialElement.
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
  
  // Get spatialdata_attrs from the element's parsed attrs
  const spatialDataAttrs = element.attrs.spatialdata_attrs;
  
  if (!spatialDataAttrs?.coordinateSystems) {
    // No coordinate systems defined - return identity or undefined
    if (getAll) {
      const map = new Map<string, BaseTransformation>();
      map.set(DEFAULT_COORDINATE_SYSTEM, new Identity());
      return map;
    }
    return new Identity();
  }
  
  const { coordinateSystems } = spatialDataAttrs;
  
  if (getAll) {
    // Return all coordinate system mappings
    const map = new Map<string, BaseTransformation>();
    for (const [csName] of Object.entries(coordinateSystems)) {
      // For now, return Identity as placeholder - actual transform parsing can be added
      map.set(csName, new Identity());
    }
    return map;
  }
  
  // Get transformation for a specific coordinate system
  if (toCoordinateSystem && coordinateSystems[toCoordinateSystem]) {
    // TODO: Convert CoordinateTransformation to BaseTransformation
    // For now return Identity
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
