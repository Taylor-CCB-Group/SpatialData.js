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
  axes: z
    .array(
      z.object({
        name: z.string(),
        type: z.enum(['space', 'time', 'channel']).optional(),
        unit: z.string().optional(),
      })
    )
    .optional(),
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
/**
 * Base transformation types (non-recursive)
 */
const scaleTransformSchema = z.object({
  type: z.literal('scale'),
  scale: z.array(z.number()).min(2),
  input: coordinateSystemRefSchema.optional(),
  output: coordinateSystemRefSchema.optional(),
});

const translationTransformSchema = z.object({
  type: z.literal('translation'),
  translation: z.array(z.number()).min(2),
  input: coordinateSystemRefSchema.optional(),
  output: coordinateSystemRefSchema.optional(),
});

const identityTransformSchema = z.object({
  type: z.literal('identity'),
  input: coordinateSystemRefSchema.optional(),
  output: coordinateSystemRefSchema.optional(),
});

const affineTransformSchema = z.object({
  type: z.literal('affine'),
  affine: z.array(z.array(z.number())).min(2),
  input: coordinateSystemRefSchema.optional(),
  output: coordinateSystemRefSchema.optional(),
});

/**
 * Union of base transformation types
 */
type BaseTransformation =
  | z.infer<typeof scaleTransformSchema>
  | z.infer<typeof translationTransformSchema>
  | z.infer<typeof identityTransformSchema>
  | z.infer<typeof affineTransformSchema>;

/**
 * Full transformation type including sequence (recursive)
 */
type SequenceTransformation = {
  type: 'sequence';
  transformations: Transformation[];
  input?: z.infer<typeof coordinateSystemRefSchema>;
  output?: z.infer<typeof coordinateSystemRefSchema>;
};

type Transformation = BaseTransformation | SequenceTransformation;

// Recursive transformation schema with explicit type annotation
const transformationSchema: z.ZodType<Transformation> = z.lazy(() =>
  z.union([
    scaleTransformSchema,
    translationTransformSchema,
    identityTransformSchema,
    affineTransformSchema,
    z.object({
      type: z.literal('sequence'),
      transformations: z.array(transformationSchema).min(1),
      input: coordinateSystemRefSchema.optional(),
      output: coordinateSystemRefSchema.optional(),
    }),
  ])
);

export const coordinateTransformationSchema = z.array(transformationSchema).min(1);

const spaceUnitSchema = z.enum([
  'angstrom',
  'attometer',
  'centimeter',
  'decimeter',
  'exameter',
  'femtometer',
  'foot',
  'gigameter',
  'hectometer',
  'inch',
  'kilometer',
  'megameter',
  'meter',
  'micrometer',
  'µm', //nb - this wasn't listed along with UDUNITS-2 things in spec doc, not sure it should be here
  'mile',
  'millimeter',
  'nanometer',
  'parsec',
  'petameter',
  'picometer',
  'terameter',
  'yard',
  'yoctometer',
  'yottameter',
  'zeptometer',
  'zettameter',
]);
const timeUnitSchema = z.enum([
  'attosecond',
  'centisecond',
  'day',
  'decisecond',
  'exasecond',
  'femtosecond',
  'gigasecond',
  'hectosecond',
  'hour',
  'kilosecond',
  'megasecond',
  'microsecond',
  'millisecond',
  'minute',
  'nanosecond',
  'petasecond',
  'picosecond',
  'second',
  'terasecond',
  'yoctosecond',
  'yottasecond',
  'zeptosecond',
  'zettasecond',
]);
/**
 * SHOULD contain the field “unit” to specify the physical unit of this dimension.
 * The value SHOULD be one of the following strings, which are valid units according to UDUNITS-2.
 * https://github.com/ome/ngff/blob/26039d997f16509f4ef7f4006ea641bef73733f7/rfc/5/versions/1/index.md?plain=1#L130
 * -- we could try to be better about distinguishing time/space units etc,
 * formally expressing that relationship.
 * For now, this whole type basically resolves to string, because other arbitrary values are also allowed
 * but we'll certainly care about units more in future.
 */
const axisUnitSchema = z.union([spaceUnitSchema, timeUnitSchema, z.string()]);
const axisSchema = z.union([
  z.object({
    name: z.string(),
    type: z.enum(['channel', 'time', 'space']),
    longName: z.string().optional(),
    unit: axisUnitSchema.optional(),
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
]);
export type Axis = z.infer<typeof axisSchema>;
const axesSchema = z.array(axisSchema).min(2).max(5);

const omeroSchema = z.object({
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
      label: z.union([z.number(), z.string()]).optional(),
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
export const spatialDataAttrsSchema = z
  .object({
    version: z.string(),
  })
  .passthrough(); // allow extra fields we don't validate yet

export type SpatialDataAttrs = z.infer<typeof spatialDataAttrsSchema>;

/**
 * Schema for raster element attrs in spatialdata 0.5.0 format
 * Has multiscales at the top level (older OME-NGFF format)
 */
const rasterAttrsV050Schema = z
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
      .min(1),
    omero: omeroSchema.optional(),
    spatialdata_attrs: spatialDataAttrsSchema.optional(),
  })
  .passthrough();

/**
 * Schema for raster element attrs in spatialdata 0.6.1+ format
 * Has multiscales nested under 'ome' key (newer OME-NGFF format)
 */
const rasterAttrsV061Schema = z
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
          .min(1),
        omero: omeroSchema.optional(),
      })
      .passthrough(),
    spatialdata_attrs: spatialDataAttrsSchema.optional(),
  })
  .passthrough();

/**
 * Schema for raster element attrs (images & labels)
 * Supports both spatialdata 0.5.0 (top-level multiscales) and 0.6.1+ (nested under 'ome') formats.
 * Uses zod transform to normalize both formats to a consistent internal representation.
 */
export const rasterAttrsSchema = z
  .union([rasterAttrsV050Schema, rasterAttrsV061Schema])
  .transform((data): RasterAttrs => {
    // If it's the v0.6.1+ format (has 'ome' key), extract multiscales and omero from it
    if ('ome' in data && data.ome && typeof data.ome === 'object') {
      const omeData = data.ome as {
        multiscales: unknown;
        omero?: unknown;
        [key: string]: unknown;
      };
      return {
        multiscales: omeData.multiscales as RasterAttrs['multiscales'],
        omero: omeData.omero as RasterAttrs['omero'],
        spatialdata_attrs: 'spatialdata_attrs' in data ? data.spatialdata_attrs : undefined,
        // Preserve any other top-level fields
        ...Object.fromEntries(
          Object.entries(data).filter(([key]) => key !== 'ome' && key !== 'spatialdata_attrs')
        ),
      } as RasterAttrs;
    }
    
    // Otherwise, it's already in the v0.5.0 format (top-level multiscales), return as-is
    return data as RasterAttrs;
  });

/**
 * Internal type for the normalized raster attrs structure
 * This is what we use internally after transformation
 */
export type RasterAttrs = {
  multiscales: Array<{
    name?: string;
    datasets: Array<{
      path: string;
      coordinateTransformations?: z.infer<typeof coordinateTransformationSchema>;
    }>;
    axes: z.infer<typeof axesSchema>;
    coordinateTransformations?: z.infer<typeof coordinateTransformationSchema>;
  }>;
  omero?: z.infer<typeof omeroSchema>;
  spatialdata_attrs?: z.infer<typeof spatialDataAttrsSchema>;
  [key: string]: unknown;
};

/**
 * Schema for shapes element attrs.
 * Transformations are at the top level with input/output coordinate system references.
 */
export const shapesAttrsSchema = z
  .object({
    'encoding-type': z.string().optional(), // e.g., 'ngff:shapes'
    axes: z.array(z.string()).optional(), // e.g., ['x', 'y']
    coordinateTransformations: coordinateTransformationSchema.optional(),
    spatialdata_attrs: spatialDataAttrsSchema.optional(),
  })
  .passthrough();

export type ShapesAttrs = z.infer<typeof shapesAttrsSchema>;

/**
 * Schema for points element attrs.
 * Transformations are at the top level with input/output coordinate system references.
 */
export const pointsAttrsSchema = z
  .object({
    'encoding-type': z.string().optional(), // e.g., 'ngff:points'
    axes: z.array(z.string()).optional(), // e.g., ['x', 'y']
    coordinateTransformations: coordinateTransformationSchema.optional(),
    spatialdata_attrs: spatialDataAttrsSchema.optional(),
  })
  .passthrough();

export type PointsAttrs = z.infer<typeof pointsAttrsSchema>;

/**
 * Schema for anndata table metadata
 */
export const tableAttrsSchema = z
  .object({
    instance_key: z.string(),
    region: z.union([z.string(), z.array(z.string())]),
    region_key: z.string(),
    'spatialdata-encoding-type': z.literal('ngff:regions_table'),
  })
  .passthrough();

export type TableAttrs = z.infer<typeof tableAttrsSchema>;

/**
 * Schema for SpatialData root metadata
 */
export const spatialDataSchema = z.object({
  version: z.string(),
  coordinateSystems: z.record(z.string(), coordinateTransformationSchema),
});

export type CoordinateTransformation = z.infer<typeof coordinateTransformationSchema>;
export type SpatialData = z.infer<typeof spatialDataSchema>;
