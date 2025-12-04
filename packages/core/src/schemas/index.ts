/**
 * Zod schemas for SpatialData validation.
 * 
 * n.b. where possible, we should be using upstream zod-ome-ngff etc.
 * In development as of this writing, trying to get something into a shape that approximately works,
 * at least for data in the form we currently have in mdv... and also our current default vitessce demo data.
 * 
 * As per upstream zod-ome-ngff, would be good to have appropriate unions of different versions, with zod transform
 * into latest schema version so that the interface used internally is always regular rather than the variance seeping out.
 */

import { z } from 'zod';

/// nb - most of the rest of this file is somewhat dead...


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
      // we're surely going to need something more here to be able to handle a reasonable subset of data
      z.object({
        type: z.literal('identity'),
      })
    ])
  )
  .min(1);

const axesSchema = z
  .array(
    z.union([
      z.object({
        name: z.string(),
        type: z.enum(['channel', 'time', 'space']),
        //SHOULD contain the field “unit” to specify the physical unit of this dimension. 
        //The value SHOULD be one of the following strings, which are valid units according to UDUNITS-2.
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

export const ome = z
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
    // version: z.literal('0.5').describe('The version of the OME-Zarr Metadata'),
  })
  .describe('The versioned OME-Zarr Metadata namespace');

export type OmeImage = z.infer<typeof ome>;

export const imageSchema = z.object({ ome }).describe('The zarr.json attributes key');

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
