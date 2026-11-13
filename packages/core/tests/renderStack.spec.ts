import { describe, expect, it } from 'vitest';
import {
  findRenderStackEntry,
  getRenderStackEntryIds,
  getRenderStackHostLayerIds,
  migrateRenderStack,
  RENDER_STACK_SCHEMA_VERSION,
  type RenderStackV1,
  renderStackGroupEntrySchema,
  renderStackHostEntrySchema,
  renderStackSchema,
  renderStackSpatialEntrySchema,
  resolveRenderStackGroupProps,
} from '../src/renderStack.js';

describe('renderStackSchema', () => {
  it('parses current render stacks', () => {
    const stack = renderStackSchema.parse({
      schemaVersion: RENDER_STACK_SCHEMA_VERSION,
      entries: [
        {
          kind: 'spatial',
          id: 'image-morphology',
          source: { elementType: 'image', elementKey: 'morphology_focus' },
          props: { opacity: 0.5 },
        },
        {
          kind: 'host',
          id: 'deck:scatter',
          source: { hostLayerId: 'deck:scatter' },
        },
      ],
    });

    expect(stack.entries.map((entry) => entry.id)).toEqual(['image-morphology', 'deck:scatter']);
    expect(stack.entries[0]).toMatchObject({
      kind: 'spatial',
      source: { elementType: 'image', elementKey: 'morphology_focus' },
      props: { opacity: 0.5 },
    });
  });

  it('rejects invalid current entries instead of migrating them', () => {
    const result = renderStackSchema.safeParse({
      entries: [
        { kind: 'host', id: 'deck:gates', source: { hostLayerId: 'deck:gates' } },
        { kind: 'spatial', id: 'bad', source: { elementType: 'not-real', elementKey: 'x' } },
      ],
    });

    expect(result.success).toBe(false);
  });

  it('rejects duplicate stack entry ids', () => {
    const result = renderStackSchema.safeParse({
      entries: [
        {
          kind: 'spatial',
          id: 'labels-cells',
          source: { elementType: 'labels', elementKey: 'cells' },
        },
        {
          kind: 'host',
          id: 'labels-cells',
          source: { hostLayerId: 'deck:selection' },
        },
      ],
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]).toMatchObject({
        path: ['entries'],
        message: 'Render stack entry ids must be unique; duplicate ids: labels-cells',
      });
    }
  });

  it('rejects unknown keys outside renderer props', () => {
    const result = renderStackSchema.safeParse({
      unexpected: true,
      entries: [
        {
          kind: 'spatial',
          id: 'labels-cells',
          source: {
            elementType: 'labels',
            elementKey: 'cells',
            unexpected: true,
          },
          unexpected: true,
          props: { extensionProp: true },
        },
      ],
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.map((issue) => issue.path.join('.'))).toEqual(
        expect.arrayContaining(['', 'entries.0', 'entries.0.source'])
      );
    }
  });
});

describe('render-stack entry schemas', () => {
  it('validates spatial entries with structural source separate from props', () => {
    const parsed = renderStackSpatialEntrySchema.parse({
      kind: 'spatial',
      id: 'shapes-cells',
      source: { elementType: 'shapes', elementKey: 'cell_boundaries' },
      props: {
        opacity: 1,
        featureState: { hiddenFeatureIds: ['cell-1'] },
      },
    });

    expect(parsed.source.elementKey).toBe('cell_boundaries');
    expect(parsed.props.featureState).toEqual({ hiddenFeatureIds: ['cell-1'] });
  });

  it('validates host overlays as descriptors instead of deck layer instances', () => {
    const parsed = renderStackHostEntrySchema.parse({
      kind: 'host',
      id: 'deck:scatter',
      source: { hostLayerId: 'deck:scatter' },
      props: { opacity: 0.8 },
    });

    expect(parsed.source.hostLayerId).toBe('deck:scatter');
  });

  it('validates group entries with nested children and typed props', () => {
    const parsed = renderStackGroupEntrySchema.parse({
      kind: 'group',
      id: 'group:blend',
      props: { opacity: 0.5, blendMode: 'multiply', isolate: true },
      children: [{ kind: 'host', id: 'deck:scatter', source: { hostLayerId: 'deck:scatter' } }],
    });

    expect(parsed.children.map((child) => child.id)).toEqual(['deck:scatter']);
    expect(parsed.props).toEqual({ opacity: 0.5, blendMode: 'multiply', isolate: true });
    expect(
      renderStackGroupEntrySchema.safeParse({ kind: 'group', id: 'g', props: { blendMode: 'x' } })
        .success
    ).toBe(false);
  });

  it('returns stack entry and host ids in canonical order', () => {
    const stack = renderStackSchema.parse({
      entries: [
        { kind: 'host', id: 'deck:scatter', source: { hostLayerId: 'deck:scatter' } },
        {
          kind: 'spatial',
          id: 'labels-cells',
          source: { elementType: 'labels', elementKey: 'cells' },
        },
        { kind: 'host', id: 'deck:selection', source: { hostLayerId: 'deck:selection' } },
      ],
    });

    expect(getRenderStackEntryIds(stack)).toEqual([
      'deck:scatter',
      'labels-cells',
      'deck:selection',
    ]);
    expect(getRenderStackHostLayerIds(stack)).toEqual(['deck:scatter', 'deck:selection']);
  });
});

const host = (id: string) => ({ kind: 'host' as const, id, source: { hostLayerId: id } });

describe('render stack tree', () => {
  const tree = renderStackSchema.parse({
    schemaVersion: 2,
    entries: [
      {
        kind: 'spatial',
        id: 'image',
        source: { elementType: 'image', elementKey: 'morphology' },
      },
      {
        kind: 'group',
        id: 'points',
        children: [
          host('deck:grey_scatter'),
          { kind: 'group', id: 'inner', children: [host('deck:scatter')] },
        ],
      },
      host('deck:selection'),
    ],
  });

  it('lists ids and host ids at any depth, in draw order', () => {
    expect(getRenderStackEntryIds(tree)).toEqual([
      'image',
      'points',
      'deck:grey_scatter',
      'inner',
      'deck:scatter',
      'deck:selection',
    ]);
    expect(getRenderStackHostLayerIds(tree)).toEqual([
      'deck:grey_scatter',
      'deck:scatter',
      'deck:selection',
    ]);
    expect(findRenderStackEntry(tree, 'deck:scatter')?.kind).toBe('host');
  });

  it('rejects an id repeated at different depths', () => {
    const result = renderStackSchema.safeParse({
      schemaVersion: 2,
      entries: [host('deck:scatter'), { kind: 'group', id: 'g', children: [host('deck:scatter')] }],
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.message).toBe(
        'Render stack entry ids must be unique; duplicate ids: deck:scatter'
      );
    }
  });

  it('accepts a host-only stack', () => {
    const stack = renderStackSchema.parse({
      schemaVersion: 2,
      entries: [{ kind: 'group', id: 'g', props: { isolate: true }, children: [host('deck:a')] }],
    });
    expect(stack.entries[0]?.kind).toBe('group');
  });

  it('resolves group defaults, with a blend mode implying isolation', () => {
    const group = (props: Record<string, unknown>) =>
      renderStackGroupEntrySchema.parse({ kind: 'group', id: 'g', props });
    expect(resolveRenderStackGroupProps(group({}))).toEqual({
      opacity: 1,
      blendMode: 'pass-through',
      isolate: false,
    });
    expect(resolveRenderStackGroupProps(group({ blendMode: 'screen' })).isolate).toBe(true);
    expect(resolveRenderStackGroupProps(group({ isolate: true, opacity: 0.5 }))).toEqual({
      opacity: 0.5,
      blendMode: 'pass-through',
      isolate: true,
    });
  });
});

describe('migrateRenderStack', () => {
  it('leaves a flat v1 stack as it was, at v2', () => {
    // MDV's default stack: an image, then its host overlays.
    const v1: RenderStackV1 = {
      schemaVersion: 1,
      entries: [
        {
          kind: 'spatial',
          id: 'image',
          visible: true,
          source: { elementType: 'image', elementKey: 'morphology' },
          props: { opacity: 1, vivLayerProps: { contrastLimits: [[0, 255]] } },
        },
        { ...host('deck:grey_scatter'), visible: false, props: {} },
        { ...host('deck:scatter'), visible: true, props: {} },
      ],
    };

    const { stack, notices } = migrateRenderStack(v1);

    expect(notices).toEqual([]);
    expect(stack).toEqual({ ...v1, schemaVersion: 2 });
    expect(renderStackSchema.parse(v1)).toEqual({ ...v1, schemaVersion: 2 });
  });

  it('returns a v2 stack unchanged', () => {
    const v2 = renderStackSchema.parse({ entries: [host('a')] });
    expect(migrateRenderStack(v2).stack).toBe(v2);
  });

  it('moves the entries a v1 group names into it, at the group position', () => {
    const { stack, notices } = migrateRenderStack({
      schemaVersion: 1,
      entries: [
        host('image'),
        host('a'),
        host('b'),
        { kind: 'group', id: 'g', children: ['b', 'a'], props: {} },
        host('top'),
      ],
    });

    expect(notices).toEqual([]);
    expect(renderStackSchema.parse(stack)).toEqual({
      schemaVersion: 2,
      entries: [
        { ...host('image'), visible: true, props: {} },
        {
          kind: 'group',
          id: 'g',
          visible: true,
          props: {},
          children: [
            { ...host('b'), visible: true, props: {} },
            { ...host('a'), visible: true, props: {} },
          ],
        },
        { ...host('top'), visible: true, props: {} },
      ],
    });
  });

  it('treats a stack with no version as v1', () => {
    const parsed = renderStackSchema.parse({
      entries: [host('a'), { kind: 'group', id: 'g', children: ['a'] }],
    });
    expect(getRenderStackEntryIds(parsed)).toEqual(['g', 'a']);
  });

  it('nests v1 groups that name each other, and drops ids that would loop', () => {
    const { stack, notices } = migrateRenderStack({
      entries: [
        host('a'),
        { kind: 'group', id: 'inner', children: ['a', 'outer'], props: {} },
        { kind: 'group', id: 'outer', children: ['inner'], props: {} },
      ],
    });

    expect(notices).toEqual([{ groupId: 'outer', childId: 'inner', reason: 'claimed' }]);
    expect(getRenderStackEntryIds(renderStackSchema.parse(stack))).toEqual(['inner', 'a', 'outer']);
  });

  it('drops missing and twice-claimed ids, and invalid group props, with notices', () => {
    const { stack, notices } = migrateRenderStack({
      schemaVersion: 1,
      entries: [
        host('a'),
        { kind: 'group', id: 'g1', children: ['a', 'nope'], props: { blendMode: 'reserved' } },
        { kind: 'group', id: 'g2', children: ['a', 'g2'], props: { opacity: 0.5, note: 'kept' } },
      ],
    });

    expect(notices).toEqual([
      { groupId: 'g1', childId: 'nope', reason: 'missing' },
      { groupId: 'g2', childId: 'a', reason: 'claimed' },
      { groupId: 'g2', childId: 'g2', reason: 'claimed' },
      { groupId: 'g1', childId: 'blendMode', reason: 'invalid-prop' },
    ]);
    const parsed = renderStackSchema.parse(stack);
    expect(getRenderStackEntryIds(parsed)).toEqual(['g1', 'a', 'g2']);
    expect(findRenderStackEntry(parsed, 'g2')).toMatchObject({
      props: { opacity: 0.5, note: 'kept' },
    });
  });

  it('keeps an id a group names twice once', () => {
    const { stack, notices } = migrateRenderStack({
      schemaVersion: 1,
      entries: [host('a'), { kind: 'group', id: 'g', children: ['a', 'a'], props: {} }],
    });

    expect(notices).toEqual([{ groupId: 'g', childId: 'a', reason: 'claimed' }]);
    expect(getRenderStackEntryIds(renderStackSchema.parse(stack))).toEqual(['g', 'a']);
  });

  it('keeps group props named like Object.prototype members', () => {
    const { stack, notices } = migrateRenderStack({
      schemaVersion: 1,
      entries: [{ kind: 'group', id: 'g', children: [], props: { constructor: 'metadata' } }],
    });

    expect(notices).toEqual([]);
    expect(findRenderStackEntry(renderStackSchema.parse(stack), 'g')).toMatchObject({
      props: { constructor: 'metadata' },
    });
  });

  it('passes anything that is not a stack through for the schema to reject', () => {
    expect(migrateRenderStack(null).stack).toBe(null);
    expect(renderStackSchema.safeParse({ schemaVersion: 3, entries: [] }).success).toBe(false);
  });
});
