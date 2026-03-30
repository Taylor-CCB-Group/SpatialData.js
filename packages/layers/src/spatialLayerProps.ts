import { z } from 'zod';

/** Current serialized props version; bump when adding breaking field changes. */
export const SPATIAL_LAYER_PROPS_SCHEMA_VERSION = 1 as const;

const sublayerBase = z.object({
  id: z.string().optional(),
  visible: z.boolean().optional().default(true),
});

export const spatialImageSublayerSchema = sublayerBase.extend({
  kind: z.literal('image'),
  /** OME-Zarr or other URL understood by Viv loaders (integrator-defined). */
  url: z.string().optional(),
});

export const spatialScatterSublayerSchema = sublayerBase.extend({
  kind: z.literal('scatter'),
});

export const spatialShapesSublayerSchema = sublayerBase.extend({
  kind: z.literal('shapes'),
  tooltipFields: z.array(z.string()).optional(),
});

export const spatialSublayerSchema = z.discriminatedUnion('kind', [
  spatialImageSublayerSchema,
  spatialScatterSublayerSchema,
  spatialShapesSublayerSchema,
]);

export type SpatialSublayer = z.infer<typeof spatialSublayerSchema>;

export const spatialLayerPropsSchema = z.object({
  schemaVersion: z.literal(SPATIAL_LAYER_PROPS_SCHEMA_VERSION).default(SPATIAL_LAYER_PROPS_SCHEMA_VERSION),
  /** 2D | 3D scene mode (reserved for Viv + deck view alignment). */
  viewMode: z.enum(['2d', '3d']).optional().default('2d'),
  /** Global time index for scenes with a time axis (non-Viv layers may consume later). */
  globalTimeIndex: z.number().int().nonnegative().optional(),
  sublayers: z.array(spatialSublayerSchema).default([]),
});

export type SpatialLayerProps = z.infer<typeof spatialLayerPropsSchema>;

/** Version 0: pre-schema ad-hoc objects (empty or partial). */
const spatialLayerPropsV0Schema = z
  .object({
    schemaVersion: z.never().optional(),
    sublayers: z.array(z.unknown()).optional(),
    viewMode: z.enum(['2d', '3d']).optional(),
    globalTimeIndex: z.number().optional(),
  })
  .passthrough();

function migrateV0ToV1(raw: z.infer<typeof spatialLayerPropsV0Schema>): SpatialLayerProps {
  const sublayersIn = raw.sublayers ?? [];
  const sublayers: SpatialSublayer[] = [];
  for (const item of sublayersIn) {
    const parsed = spatialSublayerSchema.safeParse(item);
    if (parsed.success) {
      sublayers.push(parsed.data);
    }
  }
  return spatialLayerPropsSchema.parse({
    schemaVersion: SPATIAL_LAYER_PROPS_SCHEMA_VERSION,
    viewMode: raw.viewMode ?? '2d',
    globalTimeIndex: raw.globalTimeIndex,
    sublayers,
  });
}

/**
 * Parse and migrate unknown JSON/config into the current `SpatialLayerProps`.
 * Unknown `sublayer` entries are dropped unless they match the current discriminated union.
 */
export function migrateSpatialLayerProps(raw: unknown): SpatialLayerProps {
  const v1 = spatialLayerPropsSchema.safeParse(raw);
  if (v1.success) {
    return v1.data;
  }

  const v0 = spatialLayerPropsV0Schema.safeParse(raw);
  if (v0.success) {
    return migrateV0ToV1(v0.data);
  }

  return spatialLayerPropsSchema.parse({
    schemaVersion: SPATIAL_LAYER_PROPS_SCHEMA_VERSION,
    sublayers: [],
  });
}
