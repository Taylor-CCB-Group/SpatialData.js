/**
 * Zod schemas for SpatialData validation
 */

import { z } from 'zod';


// this is generated from https://github.com/ome/ngff/blob/8cbba216e37407bd2d4bd5c7128ab13bd0a6404e/schemas/image.schema
// -> https://stefanterdell.github.io/json-schema-to-zod-react/ (the output of which had lots of errors
// which were 'fixed' by Cursor (gemini-2.5-pro, lgtm but not checked carefully), then refactored into smaller schemas.
// so entirely possible that something is not entirely correct.)
// Also not sure if we want to actually pass data through this for validation without having proper versioning...


/**
 * Schema for coordinate transformations
 */
export const coordinateTransformationSchema = z
  .array(
    z.union([
      // other transformations surely exist but not in the 0.5 OME-NGFF image.schema this is based on...
      // so if we want more general support we should consider how we structure our types/schemas etc.
      z.object({
        type: z.literal('scale'),
        scale: z.array(z.number()).min(2),
      }),
      z.object({
        type: z.literal('translation'),
        translation: z.array(z.number()).min(2),
      }),
    ])
  )
  .min(1);

const axesSchema = z
  .array(
    z.union([
      z.object({
        name: z.string(),
        type: z.enum(['channel', 'time', 'space']),
      }),
      z.object({
        name: z.string(),
        type: z
          .any()
          .refine(
            (value) => !z.enum(['space', 'time', 'channel']).safeParse(value).success,
            'Invalid input: Should NOT be valid against schema'
          )
          .optional(),
      }),
    ])
  )
  .min(2)
  .max(5);

const omeroSchema = z
  .object({
    channels: z.array(
      z.object({
        window: z
          .object({
            end: z.number(),
            max: z.number(),
            min: z.number(),
            start: z.number(),
          })
          .optional(),
        label: z.string().optional(),
        family: z.string().optional(),
        color: z.string().optional(),
        active: z.boolean().optional(),
      })
    ),
  });

export const imageSchema = z
  .object({
    ome: z
      .object({
        multiscales: z
          .array(
            z.object({
              name: z.string().optional(),
              datasets: z
                .array(
                  z.object({
                    path: z.string(),
                    coordinateTransformations: coordinateTransformationSchema.optional(),
                  })
                )
                .min(1),
              axes: axesSchema,
              coordinateTransformations: coordinateTransformationSchema.optional(),
            })
          )
          .min(1)
          .describe('The multiscale datasets for this image'),
        omero: omeroSchema.optional(),
        version: z.literal('0.5').describe('The version of the OME-Zarr Metadata'),
      })
      .describe('The versioned OME-Zarr Metadata namespace'),
  })
  .describe('The zarr.json attributes key');

export type NgffImage = z.infer<typeof imageSchema>;

/**
 * Schema for SpatialData metadata
 */
export const spatialDataSchema = z.object({
  version: z.string(),
  coordinateSystems: z.record(z.string(), coordinateTransformationSchema),
});

export type CoordinateTransformation = z.infer<typeof coordinateTransformationSchema>;
export type SpatialData = z.infer<typeof spatialDataSchema>;
