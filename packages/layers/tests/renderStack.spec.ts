import { describe, expect, it } from 'vitest';
import {
  getRenderStackEntryIds,
  getRenderStackHostLayerIds,
  RENDER_STACK_SCHEMA_VERSION,
  renderStackGroupEntrySchema,
  renderStackHostEntrySchema,
  renderStackSchema,
  renderStackSpatialEntrySchema,
} from '../src/renderStack';

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

  it('reserves group entries with ordered child ids', () => {
    const parsed = renderStackGroupEntrySchema.parse({
      kind: 'group',
      id: 'group:blend',
      children: ['image-morphology', 'labels-cells'],
      props: { blendMode: 'reserved' },
    });

    expect(parsed.children).toEqual(['image-morphology', 'labels-cells']);
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

    expect(getRenderStackEntryIds(stack)).toEqual(['deck:scatter', 'labels-cells', 'deck:selection']);
    expect(getRenderStackHostLayerIds(stack)).toEqual(['deck:scatter', 'deck:selection']);
  });
});
