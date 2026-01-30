import { z } from 'zod';
import type { ZarrV3ArrayNode } from './types';

//-------- LLM generated schemas for generic zarr metadata --------//
//       low - mid confidence in validity, need more testing


/**
 * Zod schema for non-negative integer (for shape dimensions)
 */
const nonNegativeInteger = z.number().int().nonnegative();

/**
 * Zod schema for positive integer (for chunk dimensions)
 */
const positiveInteger = z.number().int().positive();

/**
 * Zod schema for v2 filter object
 */
const v2FilterSchema = z.object({
  id: z.string(),
  configuration: z.record(z.string(), z.unknown()).optional()
}).catchall(z.unknown());

/**
 * Zod schema for v2 compressor object
 */
const v2CompressorSchema = z.object({
  id: z.string(),
  configuration: z.record(z.string(), z.unknown()).optional()
}).catchall(z.unknown());

/**
 * Zod schema for v3 codec
 */
const v3CodecSchema = z.object({
  name: z.string(),
  configuration: z.record(z.string(), z.unknown()).optional()
});

/**
 * Zod schema for v3 chunk_grid configuration
 * Note: chunk_shape can be empty for scalar arrays (0-dimensional)
 */
const v3ChunkGridConfigSchema = z.object({
  chunk_shape: z.array(positiveInteger)
});

/**
 * Zod schema for v3 chunk_grid
 */
const v3ChunkGridSchema = z.object({
  name: z.string(),
  configuration: v3ChunkGridConfigSchema
});

/**
 * Zod schema for v3 chunk_key_encoding
 */
const v3ChunkKeyEncodingSchema = z.object({
  name: z.string(),
  configuration: z.object({
    separator: z.string()
  })
});

/**
 * Base v2 zarray schema (before refines)
 * Note: shape and chunks can be empty arrays for scalar arrays (0-dimensional).
 * In zarr, a scalar is represented as shape=[] and chunks=[].
 * When not empty, chunks must contain positive integers.
 */
const v2ZarrayBaseSchema = z.object({
  shape: z.array(nonNegativeInteger),
  chunks: z.array(positiveInteger), // Empty array allowed for scalars; when not empty, values must be positive
  dtype: z.string().min(1),
  filters: z.array(v2FilterSchema).optional().nullable(),
  compressor: v2CompressorSchema.optional().nullable(),
  fill_value: z.union([z.number(), z.string(), z.boolean()]).optional(),
  dimension_names: z.array(z.string()).optional().nullable(),
  zarr_format: z.number().optional()
});

type V2ZarrayInput = z.infer<typeof v2ZarrayBaseSchema>;

/**
 * Zod schema for v2 zarray metadata
 * Handles both regular arrays and scalar arrays (empty shape/chunks)
 */
export const v2ZarraySchema = v2ZarrayBaseSchema.refine(
  (data: V2ZarrayInput) => data.chunks.length === data.shape.length,
  {
    message: 'chunks length must match shape length',
    path: ['chunks']
  }
).refine(
  (data: V2ZarrayInput) => {
    // For scalar arrays (empty shape/chunks), this check passes trivially
    if (data.shape.length === 0) return true;
    // For non-scalar arrays, each chunk must not exceed corresponding shape dimension
    return data.chunks.every((chunk: number, i: number) => chunk <= data.shape[i]);
  },
  {
    message: 'each chunk dimension must not exceed corresponding shape dimension',
    path: ['chunks']
  }
).refine(
  (data: V2ZarrayInput) => !data.dimension_names || data.dimension_names.length === data.shape.length,
  {
    message: 'dimension_names length must match shape length',
    path: ['dimension_names']
  }
);

/**
 * Base v3 zarray schema (before refines)
 * Note: shape and chunk_shape can be empty arrays for scalar arrays (0-dimensional).
 * In zarr, a scalar is represented as shape=[] and chunk_shape=[].
 */
const v3ZarrayBaseSchema = z.object({
  shape: z.array(nonNegativeInteger), // Empty array allowed for scalars
  data_type: z.string().min(1),
  chunk_grid: v3ChunkGridSchema,
  chunk_key_encoding: v3ChunkKeyEncodingSchema.optional(),
  fill_value: z.union([z.number(), z.string(), z.boolean()]).optional(),
  codecs: z.array(v3CodecSchema).optional().nullable(),
  dimension_names: z.array(z.string()).optional().nullable(),
  storage_transformers: z.array(z.unknown()).optional().nullable(),
  zarr_format: z.number().optional(),
  node_type: z.literal('array').optional()
});

type V3ZarrayInput = z.infer<typeof v3ZarrayBaseSchema>;

/**
 * Zod schema for v3 zarray metadata (for hybrid formats)
 * Handles both regular arrays and scalar arrays (empty shape/chunk_shape)
 */
export const v3ZarraySchema = v3ZarrayBaseSchema.refine(
  (data: V3ZarrayInput) => data.chunk_grid.configuration.chunk_shape.length === data.shape.length,
  {
    message: 'chunk_shape length must match shape length',
    path: ['chunk_grid', 'configuration', 'chunk_shape']
  }
).refine(
  (data: V3ZarrayInput) => {
    // For scalar arrays (empty shape/chunk_shape), this check passes trivially
    if (data.shape.length === 0) return true;
    // For non-scalar arrays, each chunk must not exceed corresponding shape dimension
    return data.chunk_grid.configuration.chunk_shape.every((chunk: number, i: number) => chunk <= data.shape[i]);
  },
  {
    message: 'each chunk dimension must not exceed corresponding shape dimension',
    path: ['chunk_grid', 'configuration', 'chunk_shape']
  }
).refine(
  (data: V3ZarrayInput) => !data.dimension_names || data.dimension_names.length === data.shape.length,
  {
    message: 'dimension_names length must match shape length',
    path: ['dimension_names']
  }
);

/**
 * Validate and convert v2 zarray metadata to v3 format
 * Handles both pure v2 format (with chunks, dtype) and hybrid formats
 * @throws Error if required fields are missing or invalid
 */
export function validateAndConvertV2Zarray(
  zarray: unknown,
  path: string
): ZarrV3ArrayNode {
  const obj = zarray as Record<string, unknown>;

  // Check if this already has v3 fields (hybrid/partially converted format)
  const hasV3Fields = 'data_type' in obj && 'chunk_grid' in obj;
  const hasV2Fields = 'shape' in obj && 'chunks' in obj && 'dtype' in obj;

  if (hasV3Fields && !hasV2Fields) {
    // Already in v3 format - validate v3 fields
    return validateV3Zarray(zarray, path);
  }

  // Validate v2 format
  const parseResult = v2ZarraySchema.safeParse(zarray);
  if (!parseResult.success) {
    const errors = parseResult.error.issues.map((e: z.ZodIssue) => {
      const pathStr = e.path.length > 0 ? `'${e.path.join('.')}'` : '';
      return `${pathStr}${pathStr ? ': ' : ''}${e.message}`;
    }).join('; ');
    throw new Error(`Invalid .zarray metadata at path '${path}': ${errors}`);
  }

  const v2 = parseResult.data;

  // Convert v2 compressor and filters to v3 codecs
  const codecs: ZarrV3ArrayNode['codecs'] = [];
  
  // Add filters first (if present)
  if (v2.filters) {
    for (const filter of v2.filters) {
      codecs.push({
        name: filter.id,
        configuration: filter.configuration
      });
    }
  }

  // Add compressor (if present and not null)
  if (v2.compressor) {
    codecs.push({
      name: v2.compressor.id,
      configuration: v2.compressor.configuration
    });
  }

  // Build v3 array node
  return {
    shape: v2.shape,
    data_type: v2.dtype,
    chunk_grid: {
      name: 'regular',
      configuration: { chunk_shape: v2.chunks }
    },
    chunk_key_encoding: {
      name: 'default',
      configuration: { separator: '/' }
    },
    fill_value: v2.fill_value ?? 0,
    codecs,
    attributes: {},
    dimension_names: v2.dimension_names ?? [],
    zarr_format: 3,
    node_type: 'array',
    storage_transformers: []
  };
}

/**
 * Validate v3 zarray metadata (for hybrid formats that already have v3 fields)
 * @throws Error if required fields are missing or invalid
 */
export function validateV3Zarray(
  zarray: unknown,
  path: string
): ZarrV3ArrayNode {
  const parseResult = v3ZarraySchema.safeParse(zarray);
  if (!parseResult.success) {
    const errors = parseResult.error.issues.map((e: z.ZodIssue) => {
      const pathStr = e.path.length > 0 ? `'${e.path.join('.')}'` : '';
      return `${pathStr}${pathStr ? ': ' : ''}${e.message}`;
    }).join('; ');
    throw new Error(`Invalid .zarray metadata at path '${path}': ${errors}`);
  }

  const v3 = parseResult.data;

  return {
    shape: v3.shape,
    data_type: v3.data_type,
    chunk_grid: v3.chunk_grid,
    chunk_key_encoding: v3.chunk_key_encoding ?? {
      name: 'default',
      configuration: { separator: '/' }
    },
    fill_value: v3.fill_value ?? 0,
    codecs: v3.codecs ?? [],
    attributes: {},
    dimension_names: v3.dimension_names ?? [],
    zarr_format: 3,
    node_type: 'array',
    storage_transformers: v3.storage_transformers ?? []
  };
}

