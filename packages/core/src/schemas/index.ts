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


/**
 * Schema for coordinate system references in NGFF 0.5+ transformations.
 * Each transformation can specify input/output coordinate systems.
 */
const coordinateSystemRefSchema = z.object({
  name: z.string(),
  axes: z.array(z.object({
    name: z.string(),
    type: z.enum(['space', 'time', 'channel']).optional(),
    unit: z.string().optional(),
  })).optional(),
});

/**
 * Schema for coordinate transformations
 * 
 * Note: Uses z.lazy() for the 'sequence' type to handle self-referential structure
 * where a sequence transformation contains an array of transformations.
 * 
 * In NGFF 0.5+, transformations can have input/output coordinate system references
 * to specify which coordinate systems they map between.
 */
const baseTransformationSchema = z.union([
  z.object({
    type: z.literal('scale'),
    scale: z.array(z.number()).min(2),
    input: coordinateSystemRefSchema.optional(),
    output: coordinateSystemRefSchema.optional(),
  }),
  z.object({
    type: z.literal('translation'),
    translation: z.array(z.number()).min(2),
    input: coordinateSystemRefSchema.optional(),
    output: coordinateSystemRefSchema.optional(),
  }),
  z.object({
    type: z.literal('identity'),
    input: coordinateSystemRefSchema.optional(),
    output: coordinateSystemRefSchema.optional(),
  }),
  z.object({
    type: z.literal('affine'),
    affine: z.array(z.array(z.number())).min(2),
    input: coordinateSystemRefSchema.optional(),
    output: coordinateSystemRefSchema.optional(),
  })
]);

// Recursive transformation type that includes 'sequence'
const transformationSchema: z.ZodType = z.lazy(() =>
  z.union([
    baseTransformationSchema,
    z.object({
      type: z.literal('sequence'),
      transformations: z.array(transformationSchema).min(1),
    }),
  ])
);

export const coordinateTransformationSchema = z.array(transformationSchema).min(1);

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
 * Schema for spatialdata_attrs metadata (common to spatial elements).
 * Contains version info and other spatialdata-specific metadata.
 * Note: Transformations are stored at the top level of attrs, not inside spatialdata_attrs.
 */
export const spatialDataAttrsSchema = z.object({
  version: z.string(),
}).passthrough(); // allow extra fields we don't validate yet

export type SpatialDataAttrs = z.infer<typeof spatialDataAttrsSchema>;

/**
 * Schema for raster element attrs (images & labels)
 * Combines OME-NGFF multiscales with spatialdata_attrs
 */
export const rasterAttrsSchema = z.object({
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
    .min(1),
  omero: omeroSchema.optional(),
  spatialdata_attrs: spatialDataAttrsSchema.optional(),
}).passthrough();

export type RasterAttrs = z.infer<typeof rasterAttrsSchema>;

/**
 * Schema for shapes element attrs.
 * Transformations are at the top level with input/output coordinate system references.
 */
export const shapesAttrsSchema = z.object({
  'encoding-type': z.string().optional(), // e.g., 'ngff:shapes'
  axes: z.array(z.string()).optional(), // e.g., ['x', 'y']
  coordinateTransformations: coordinateTransformationSchema.optional(),
  spatialdata_attrs: spatialDataAttrsSchema.optional(),
}).passthrough();

export type ShapesAttrs = z.infer<typeof shapesAttrsSchema>;

/**
 * Schema for points element attrs.
 * Transformations are at the top level with input/output coordinate system references.
 */
export const pointsAttrsSchema = z.object({
  'encoding-type': z.string().optional(), // e.g., 'ngff:points'
  axes: z.array(z.string()).optional(), // e.g., ['x', 'y']
  coordinateTransformations: coordinateTransformationSchema.optional(),
  spatialdata_attrs: spatialDataAttrsSchema.optional(),
}).passthrough();

export type PointsAttrs = z.infer<typeof pointsAttrsSchema>;

/**
 * Schema for anndata table metadata
 */
export const tableAttrsSchema = z.object({
  'instance_key': z.string(),
  'region': z.union([z.string(), z.array(z.string())]),
  'region_key': z.string(),
  'spatialdata-encoding-type': z.literal('ngff:regions_table')
}).passthrough();

export type TableAttrs = z.infer<typeof tableAttrsSchema>;

/**
 * Schema for SpatialData root metadata 
 */
export const spatialDataSchema = z.object({
  version: z.string(),
  coordinateSystems: z.record(z.string(), coordinateTransformationSchema),
});  


//todo: fix this type
export type CoordinateTransformation = z.infer<typeof coordinateTransformationSchema>;
export type SpatialData = z.infer<typeof spatialDataSchema>;
