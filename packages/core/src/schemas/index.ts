/**
 * Zod schemas for SpatialData validation
 */

import { z } from 'zod';

/**
 * Schema for coordinate transformations
 */
export const coordinateTransformationSchema = z.object({
  type: z.string(),
  transform: z.array(z.array(z.number())),
});

/**
 * Schema for SpatialData metadata
 */
export const spatialDataSchema = z.object({
  version: z.string(),
  coordinateSystems: z.record(z.string(), coordinateTransformationSchema),
});

export type CoordinateTransformation = z.infer<typeof coordinateTransformationSchema>;
export type SpatialData = z.infer<typeof spatialDataSchema>;
