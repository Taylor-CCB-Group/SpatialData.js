import { z } from 'zod';

/** Current serialized render-stack version; bump for breaking saved-stack changes. */
export const RENDER_STACK_SCHEMA_VERSION = 2 as const;

export const renderStackSpatialElementTypeSchema = z.enum(['image', 'shapes', 'points', 'labels']);

/** How an entry, or an isolated group's composite, blends with what is beneath it. */
export const renderStackBlendModeSchema = z.enum([
  'normal',
  'additive',
  'multiply',
  'screen',
  'max',
  'min',
]);

/** A group's blend mode. `pass-through` means each child blends by its own mode. */
export const renderStackGroupBlendModeSchema = z.enum([
  'pass-through',
  ...renderStackBlendModeSchema.options,
]);

/**
 * Renderer props for spatial and host entries. Open-ended, except for the keys the
 * stack itself interprets.
 */
const leafPropsSchema = z
  .looseObject({
    /** Saved, but not yet drawn: blending goes through groups for now. */
    blendMode: renderStackBlendModeSchema.optional(),
  })
  .default({});

const groupPropsShape = {
  /** Default 1. On a pass-through group this multiplies into each child's opacity. */
  opacity: z.number().min(0).max(1).optional(),
  /** Default `pass-through`. Any other mode implies `isolate`. */
  blendMode: renderStackGroupBlendModeSchema.optional(),
  /** Default false. Draw the children into their own target, then composite it. */
  isolate: z.boolean().optional(),
};

export const renderStackGroupPropsSchema = z.looseObject(groupPropsShape).default({});

const entryCommon = {
  /** Stable logical id for saved config, UI rows, host overlays, and deck layer ordering. */
  id: z.string().min(1),
  /** Hides the entry and, for a group, everything under it. */
  visible: z.boolean().optional().default(true),
};

export const renderStackSpatialEntrySchema = z.strictObject({
  ...entryCommon,
  kind: z.literal('spatial'),
  source: z.strictObject({
    elementType: renderStackSpatialElementTypeSchema,
    elementKey: z.string().min(1),
    coordinateSystem: z.string().optional(),
  }),
  /** Renderer props for this entry. Keep structural source identity out of this bag. */
  props: leafPropsSchema,
});

export const renderStackHostEntrySchema = z.strictObject({
  ...entryCommon,
  kind: z.literal('host'),
  source: z.strictObject({
    /** Host-owned stable descriptor, e.g. `deck:scatter` or `deck:selection`. */
    hostLayerId: z.string().min(1),
  }),
  props: leafPropsSchema,
});

export type RenderStackSpatialElementType = z.infer<typeof renderStackSpatialElementTypeSchema>;
export type RenderStackSpatialEntry = z.infer<typeof renderStackSpatialEntrySchema>;
export type RenderStackHostEntry = z.infer<typeof renderStackHostEntrySchema>;
export type RenderStackGroupProps = z.infer<typeof renderStackGroupPropsSchema>;
export type RenderStackBlendMode = z.infer<typeof renderStackBlendModeSchema>;
export type RenderStackGroupBlendMode = z.infer<typeof renderStackGroupBlendModeSchema>;

export type RenderStackGroupEntry = {
  kind: 'group';
  id: string;
  visible: boolean;
  props: RenderStackGroupProps;
  /** Drawn in order, bottom to top. */
  children: RenderStackEntry[];
};
export type RenderStackEntry =
  | RenderStackSpatialEntry
  | RenderStackHostEntry
  | RenderStackGroupEntry;

type RenderStackEntryInput =
  | z.input<typeof renderStackSpatialEntrySchema>
  | z.input<typeof renderStackHostEntrySchema>
  | {
      kind: 'group';
      id: string;
      visible?: boolean;
      props?: z.input<typeof renderStackGroupPropsSchema>;
      children?: RenderStackEntryInput[];
    };

export const renderStackGroupEntrySchema = z.strictObject({
  ...entryCommon,
  kind: z.literal('group'),
  props: renderStackGroupPropsSchema,
  // Annotated, because the schema refers to itself through the entry union.
  get children(): z.ZodDefault<z.ZodArray<z.ZodType<RenderStackEntry, RenderStackEntryInput>>> {
    return z.array(renderStackEntrySchema).default([]);
  },
});

export const renderStackEntrySchema = z.discriminatedUnion('kind', [
  renderStackSpatialEntrySchema,
  renderStackHostEntrySchema,
  renderStackGroupEntrySchema,
]);

/** Visits every entry depth-first in draw order, a group before its children. */
export function* walkRenderStackEntries(
  entries: readonly RenderStackEntry[]
): Generator<RenderStackEntry> {
  for (const entry of entries) {
    yield entry;
    if (entry.kind === 'group') yield* walkRenderStackEntries(entry.children);
  }
}

const renderStackV2Schema = z
  .strictObject({
    schemaVersion: z.literal(RENDER_STACK_SCHEMA_VERSION).default(RENDER_STACK_SCHEMA_VERSION),
    entries: z.array(renderStackEntrySchema).default([]),
  })
  .superRefine((renderStack, ctx) => {
    const seen = new Set<string>();
    const duplicateIds = new Set<string>();

    for (const entry of walkRenderStackEntries(renderStack.entries)) {
      if (seen.has(entry.id)) {
        duplicateIds.add(entry.id);
      }
      seen.add(entry.id);
    }

    if (duplicateIds.size > 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['entries'],
        message: `Render stack entry ids must be unique; duplicate ids: ${Array.from(
          duplicateIds
        ).join(', ')}`,
      });
    }
  });

export type RenderStack = z.infer<typeof renderStackV2Schema>;

/**
 * A stack as saved by schema v1: flat, with each group naming other top-level
 * entries by id. Its group props were opaque.
 */
export type RenderStackV1 = {
  schemaVersion?: 1;
  entries: Array<
    | RenderStackSpatialEntry
    | RenderStackHostEntry
    | {
        kind: 'group';
        id: string;
        visible: boolean;
        props: Record<string, unknown>;
        children: string[];
      }
  >;
};

export type RenderStackMigrationNotice = {
  groupId: string;
  /** The child id, or for `invalid-prop` the prop name. */
  childId: string;
  /**
   * - `missing`: no top-level entry has the id.
   * - `claimed`: an earlier group already took it, or taking it would nest a group
   *   inside itself.
   * - `invalid-prop`: v1 group props were opaque, and this one has a value v2
   *   rejects, so it was dropped.
   */
  reason: 'missing' | 'claimed' | 'invalid-prop';
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isGroupPropKey(key: string): key is keyof typeof groupPropsShape {
  return key in groupPropsShape;
}

/** v2 group props: other keys kept, typed keys kept only when valid. */
function migrateGroupProps(
  groupId: string,
  props: unknown,
  notices: RenderStackMigrationNotice[]
): Record<string, unknown> {
  if (!isRecord(props)) return {};
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(props)) {
    if (isGroupPropKey(key) && !groupPropsShape[key].safeParse(value).success) {
      notices.push({ groupId, childId: key, reason: 'invalid-prop' });
    } else {
      out[key] = value;
    }
  }
  return out;
}

/**
 * Upgrades a v1 stack to v2. A v2 stack comes back as it is, with no notices.
 *
 * Each v1 group takes the top-level entries its `children` ids name, in that order,
 * and keeps its own position. That matches what v1 drew when the group came after
 * its children, which is how v1 stacks were written. An id goes to the first group
 * that names it. Ids that name nothing, or are already taken, are dropped with a
 * notice. Input that is not shaped like a stack comes back unchanged, for the
 * schema to reject.
 *
 * The result is not validated: parse it with `renderStackSchema` for that.
 */
export function migrateRenderStack(input: RenderStackV1 | RenderStack): {
  stack: RenderStack;
  notices: RenderStackMigrationNotice[];
};
export function migrateRenderStack(input: unknown): {
  stack: unknown;
  notices: RenderStackMigrationNotice[];
};
export function migrateRenderStack(input: unknown): {
  stack: unknown;
  notices: RenderStackMigrationNotice[];
} {
  const notices: RenderStackMigrationNotice[] = [];
  const entries = isRecord(input) ? (input.entries ?? []) : undefined;
  if (
    !isRecord(input) ||
    !(input.schemaVersion === undefined || input.schemaVersion === 1) ||
    !Array.isArray(entries)
  ) {
    return { stack: input, notices };
  }

  const byId = new Map<string, Record<string, unknown>>();
  for (const entry of entries) {
    if (isRecord(entry) && typeof entry.id === 'string' && !byId.has(entry.id)) {
      byId.set(entry.id, entry);
    }
  }
  const childrenOf = (entry: Record<string, unknown>): unknown[] =>
    entry.kind === 'group' && Array.isArray(entry.children) ? entry.children : [];

  // Pass 1: each id goes to the first group that names it, unless the group is that
  // entry or sits under it.
  const parentOf = new Map<string, string>();
  const isSelfOrAncestor = (candidate: string, of: string): boolean => {
    for (let id: string | undefined = of; id !== undefined; id = parentOf.get(id)) {
      if (id === candidate) return true;
    }
    return false;
  };
  for (const entry of entries) {
    if (!isRecord(entry) || typeof entry.id !== 'string') continue;
    for (const childId of childrenOf(entry)) {
      if (typeof childId !== 'string') continue;
      if (!byId.has(childId)) {
        notices.push({ groupId: entry.id, childId, reason: 'missing' });
      } else if (parentOf.has(childId) || isSelfOrAncestor(childId, entry.id)) {
        notices.push({ groupId: entry.id, childId, reason: 'claimed' });
      } else {
        parentOf.set(childId, entry.id);
      }
    }
  }

  // Pass 2: build the tree from the roots down. Pass 1 rules out cycles.
  const build = (entry: unknown): unknown => {
    if (!isRecord(entry) || entry.kind !== 'group' || typeof entry.id !== 'string') return entry;
    const groupId = entry.id;
    const children: unknown[] = [];
    for (const child of childrenOf(entry)) {
      if (typeof child !== 'string') children.push(build(child));
      else if (parentOf.get(child) === groupId) children.push(build(byId.get(child)));
    }
    return { ...entry, props: migrateGroupProps(groupId, entry.props, notices), children };
  };
  const roots = entries.filter(
    (entry) => !(isRecord(entry) && typeof entry.id === 'string' && parentOf.has(entry.id))
  );

  return {
    stack: { ...input, schemaVersion: RENDER_STACK_SCHEMA_VERSION, entries: roots.map(build) },
    notices,
  };
}

/** Parses a v2 stack, upgrading a v1 stack first (see `migrateRenderStack`). */
export const renderStackSchema = z.preprocess(
  (input) => migrateRenderStack(input).stack,
  renderStackV2Schema
);

/** Every entry id, depth-first in draw order, a group before its children. */
export function getRenderStackEntryIds(renderStack: RenderStack): string[] {
  return Array.from(walkRenderStackEntries(renderStack.entries), (entry) => entry.id);
}

/** Every host layer id at any depth, in draw order. */
export function getRenderStackHostLayerIds(renderStack: RenderStack): string[] {
  const ids: string[] = [];
  for (const entry of walkRenderStackEntries(renderStack.entries)) {
    if (entry.kind === 'host') ids.push(entry.source.hostLayerId);
  }
  return ids;
}

/** The entry with this id, at any depth. */
export function findRenderStackEntry(
  renderStack: RenderStack,
  id: string
): RenderStackEntry | undefined {
  for (const entry of walkRenderStackEntries(renderStack.entries)) {
    if (entry.id === id) return entry;
  }
  return undefined;
}

/** A group's props with defaults applied, and `isolate` implied by its blend mode. */
export function resolveRenderStackGroupProps(group: RenderStackGroupEntry): {
  opacity: number;
  blendMode: RenderStackGroupBlendMode;
  isolate: boolean;
} {
  const blendMode = group.props.blendMode ?? 'pass-through';
  return {
    opacity: group.props.opacity ?? 1,
    blendMode,
    isolate: group.props.isolate === true || blendMode !== 'pass-through',
  };
}
