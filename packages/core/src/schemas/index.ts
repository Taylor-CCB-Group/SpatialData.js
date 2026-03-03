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

/**
 * Spatial units from OME-NGFF specification.
 * Valid UDUNITS-2 spatial units.
 * @see https://github.com/ome/ngff/blob/26039d997f16509f4ef7f4006ea641bef73733f7/rfc/5/versions/1/index.md?plain=1#L131
 */
export const spaceUnitSchema = z.enum([
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

/**
 * Time units from OME-NGFF specification.
 * Valid UDUNITS-2 time units.
 * @see https://github.com/ome/ngff/blob/26039d997f16509f4ef7f4006ea641bef73733f7/rfc/5/versions/1/index.md?plain=1#L132
 */
export const timeUnitSchema = z.enum([
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
 * Extract enum values from a zod enum schema as a Set of strings.
 */
function getEnumValues(schema: z.ZodEnum<Record<string, string>>): Set<string> {
  return new Set(schema.options);
}

/**
 * Set of all valid spatial unit strings from OME-NGFF specification.
 * Derived from spaceUnitSchema to ensure consistency.
 * @see spaceUnitSchema
 */
export const SPATIAL_UNITS: Set<string> = getEnumValues(spaceUnitSchema);

/**
 * Set of all valid time unit strings from OME-NGFF specification.
 * Derived from timeUnitSchema to ensure consistency.
 * @see timeUnitSchema
 */
export const TIME_UNITS: Set<string> = getEnumValues(timeUnitSchema);
/**
 * SHOULD contain the field "unit" to specify the physical unit of this dimension.
 * The value SHOULD be one of the following strings, which are valid units according to UDUNITS-2.
 * @see https://github.com/ome/ngff/blob/26039d997f16509f4ef7f4006ea641bef73733f7/rfc/5/versions/1/index.md?plain=1#L130
 * 
 * Note: This schema is relaxed to allow arbitrary string values (e.g., generic "unit" placeholder)
 * for backward compatibility, but prefers validated spatial and time units when available.
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
      // note - I think the schema says string but I encountered number in the wild.
      label: z.coerce.string().optional(),
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
 * 
 * IMPORTANT: The semantic meaning of `version` varies by element type:
 * - For raster elements (images/labels): `version` is the spatialdata library version (e.g., '0.5.0', '0.6.1', '0.7.2')
 *   and does NOT control OME-NGFF format detection (which is determined by structure).
 * - For shapes/points: `version` is the spatialdata format version (e.g., '0.1', '0.2') and IS used for format detection.
 */
export const spatialDataAttrsSchema = z
  .object({
    version: z.string(),
  })
  .passthrough(); // allow extra fields we don't validate yet

export type SpatialDataAttrs = z.infer<typeof spatialDataAttrsSchema>;

/**
 * Schema for raster element attrs in spatialdata 0.5.0 format
 * Uses OME-NGFF 0.4 format with multiscales at the top level
 */
const rasterAttrs_OME_04_Schema = z
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
 * Uses OME-NGFF 0.5 format with multiscales nested under 'ome' key
 */
const rasterAttrs_OME_05_Schema = z
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
 * Supports both spatialdata 0.5.0 (OME-NGFF 0.4, top-level multiscales) and
 * spatialdata 0.6.0+ (OME-NGFF 0.5, nested under 'ome') formats.
 * Uses zod transform to normalize both formats to a consistent internal representation.
 * 
 * NOTE: Format detection is STRUCTURAL (presence of 'ome' key), NOT based on
 * spatialdata_attrs.version. The version field is metadata only and does not control
 * which schema is applied.
 */
export const rasterAttrsSchema = z
  .union([rasterAttrs_OME_04_Schema, rasterAttrs_OME_05_Schema])
  .transform((data): RasterAttrs => {
    // Format detection is structural: if 'ome' key exists, it's OME-NGFF 0.5 format
    // This is independent of spatialdata_attrs.version (which is library version metadata)
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
