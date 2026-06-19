import { z } from 'zod';

/** Current serialized render-stack version; bump for breaking saved-stack changes. */
export const RENDER_STACK_SCHEMA_VERSION = 1 as const;

export const renderStackSpatialElementTypeSchema = z.enum([
  'image',
  'shapes',
  'points',
  'labels',
]);

const jsonishRecordSchema = z.record(z.string(), z.unknown()).default({});

const renderStackEntryBaseSchema = z.object({
  /** Stable logical id for saved config, UI rows, host overlays, and deck layer ordering. */
  id: z.string().min(1),
  /** Visibility is common stack state, independent of renderer-specific props. */
  visible: z.boolean().optional().default(true),
  /** Renderer props for this entry. Keep structural source identity out of this bag. */
  props: jsonishRecordSchema.optional().default({}),
});

export const renderStackSpatialEntrySchema = renderStackEntryBaseSchema.extend({
  kind: z.literal('spatial'),
  source: z.object({
    elementType: renderStackSpatialElementTypeSchema,
    elementKey: z.string().min(1),
    coordinateSystem: z.string().optional(),
  }),
});

export const renderStackHostEntrySchema = renderStackEntryBaseSchema.extend({
  kind: z.literal('host'),
  source: z.object({
    /** Host-owned stable descriptor, e.g. `deck:scatter` or `deck:selection`. */
    hostLayerId: z.string().min(1),
  }),
});

export const renderStackGroupEntrySchema = renderStackEntryBaseSchema.extend({
  kind: z.literal('group'),
  /**
   * Reserved for future framebuffer/blending work. For now these are child entry
   * ids rather than nested objects so flat saved stacks can migrate cheaply.
   */
  children: z.array(z.string().min(1)).optional().default([]),
});

export const renderStackEntrySchema = z.discriminatedUnion('kind', [
  renderStackSpatialEntrySchema,
  renderStackHostEntrySchema,
  renderStackGroupEntrySchema,
]);

export const renderStackSchema = z.object({
  schemaVersion: z.literal(RENDER_STACK_SCHEMA_VERSION).default(RENDER_STACK_SCHEMA_VERSION),
  entries: z.array(renderStackEntrySchema).default([]),
});

export type RenderStackSpatialElementType = z.infer<typeof renderStackSpatialElementTypeSchema>;
export type RenderStackSpatialEntry = z.infer<typeof renderStackSpatialEntrySchema>;
export type RenderStackHostEntry = z.infer<typeof renderStackHostEntrySchema>;
export type RenderStackGroupEntry = z.infer<typeof renderStackGroupEntrySchema>;
export type RenderStackEntry = z.infer<typeof renderStackEntrySchema>;
export type RenderStack = z.infer<typeof renderStackSchema>;

export function getRenderStackEntryIds(renderStack: RenderStack): string[] {
  return renderStack.entries.map((entry) => entry.id);
}

export function getRenderStackHostLayerIds(renderStack: RenderStack): string[] {
  return renderStack.entries
    .filter((entry): entry is RenderStackHostEntry => entry.kind === 'host')
    .map((entry) => entry.source.hostLayerId);
}
