import { Layer } from '@deck.gl/core';
import { ScatterplotLayer } from '@deck.gl/layers';
import { IsolatedGroupLayer, renderStackSchema } from '@spatialdata/layers';
import { describe, expect, it } from 'vitest';
import {
  renderStackOrder,
  renderStackToDeckLayers,
  renderStackToLayerInputs,
  resolveRenderStackHostLayers,
  sortLayersByRenderStackOrder,
} from '../src/SpatialCanvas/renderStackAdapters.js';
import {
  composeSpatialDeckLayers,
  shouldAutoFitSpatialView,
  shouldRenderInternalTooltip,
} from '../src/SpatialCanvas/SpatialCanvasViewer.js';

describe('composeSpatialDeckLayers', () => {
  it('places caller-provided deck layers after generated SpatialData layers', () => {
    const generated = new ScatterplotLayer({ id: 'generated', data: [], getPosition: [0, 0] });
    const external = new ScatterplotLayer({ id: 'external', data: [], getPosition: [0, 0] });

    expect(composeSpatialDeckLayers([generated], [external]).map((layer) => layer.id)).toEqual([
      'generated',
      'external',
    ]);
  });
});

describe('render stack adapters', () => {
  it('normalizes spatial entries into existing layer inputs', () => {
    const stack = renderStackSchema.parse({
      entries: [
        {
          kind: 'spatial',
          id: 'image-morphology',
          source: { elementType: 'image', elementKey: 'morphology_focus' },
          props: { opacity: 0.4 },
        },
        {
          kind: 'host',
          id: 'deck:scatter',
          source: { hostLayerId: 'deck:scatter' },
        },
        {
          kind: 'spatial',
          id: 'shapes-cells',
          visible: false,
          source: { elementType: 'shapes', elementKey: 'cell_boundaries' },
        },
      ],
    });

    const inputs = renderStackToLayerInputs(stack);
    expect(inputs.layerOrder).toEqual(['image-morphology', 'shapes-cells']);
    expect(inputs.layers['image-morphology']).toMatchObject({
      id: 'image-morphology',
      type: 'image',
      elementKey: 'morphology_focus',
      opacity: 0.4,
      visible: true,
    });
    expect(inputs.layers['shapes-cells']).toMatchObject({
      id: 'shapes-cells',
      type: 'shapes',
      elementKey: 'cell_boundaries',
      visible: false,
    });
  });

  it('resolves host descriptors into deck layers with stack ids', () => {
    const stack = renderStackSchema.parse({
      entries: [{ kind: 'host', id: 'deck:scatter', source: { hostLayerId: 'scatter' } }],
    });
    const resolved = resolveRenderStackHostLayers(stack, () => {
      return new ScatterplotLayer({ id: 'runtime-scatter', data: [], getPosition: [0, 0] });
    });

    expect(resolved.map((layer) => layer.id)).toEqual(['deck:scatter']);
  });

  it('resolves multi-layer host descriptors into deck layers with stack ids', () => {
    const stack = renderStackSchema.parse({
      entries: [{ kind: 'host', id: 'deck:selection', source: { hostLayerId: 'selection' } }],
    });
    const resolved = resolveRenderStackHostLayers(stack, () => {
      return [
        new ScatterplotLayer({ id: 'runtime-selection-fill', data: [], getPosition: [0, 0] }),
        new ScatterplotLayer({ id: 'runtime-selection-outline', data: [], getPosition: [0, 0] }),
      ];
    });

    expect(resolved.map((layer) => layer.id)).toEqual(['deck:selection', 'deck:selection']);
    expect(
      sortLayersByRenderStackOrder(
        [
          new ScatterplotLayer({ id: 'spatial-labels', data: [], getPosition: [0, 0] }),
          ...resolved,
        ],
        ['deck:selection', 'spatial-labels']
      ).map((layer) => layer.id)
    ).toEqual(['deck:selection', 'deck:selection', 'spatial-labels']);
  });

  it('reports unknown host descriptors', () => {
    const stack = renderStackSchema.parse({
      entries: [{ kind: 'host', id: 'deck:missing', source: { hostLayerId: 'missing' } }],
    });
    const unknown: string[] = [];

    const resolved = resolveRenderStackHostLayers(
      stack,
      () => undefined,
      (entry) => unknown.push(entry.id)
    );

    expect(resolved).toEqual([]);
    expect(unknown).toEqual(['deck:missing']);
  });

  it('sorts materialized deck layers by render stack order', () => {
    const layers = [
      new ScatterplotLayer({ id: 'shapes-cells', data: [], getPosition: [0, 0] }),
      new ScatterplotLayer({ id: 'deck:scatter', data: [], getPosition: [0, 0] }),
      new ScatterplotLayer({ id: 'unmanaged', data: [], getPosition: [0, 0] }),
    ];

    expect(
      sortLayersByRenderStackOrder(layers, ['deck:scatter', 'shapes-cells']).map(
        (layer) => layer.id
      )
    ).toEqual(['deck:scatter', 'shapes-cells', 'unmanaged']);
  });

  it('orders entries at any depth, groups in place', () => {
    const stack = renderStackSchema.parse({
      schemaVersion: 2,
      entries: [
        host('deck:a'),
        { kind: 'group', id: 'g', children: [host('deck:b'), image('image-a')] },
        host('deck:c'),
      ],
    });

    expect(renderStackOrder(stack, [])).toEqual(['deck:a', 'deck:b', 'image-a', 'deck:c']);
  });

  it('keeps the order a v1 stack drew with its group', () => {
    const stack = renderStackSchema.parse({
      entries: [
        image('image-a'),
        host('deck:b'),
        { kind: 'group', id: 'group:blend', children: ['deck:b', 'image-a'] },
      ],
    });

    expect(renderStackOrder(stack, [])).toEqual(['deck:b', 'image-a']);
  });
});

const host = (id: string) => ({ kind: 'host' as const, id, source: { hostLayerId: id } });
const image = (id: string, props: Record<string, unknown> = {}) => ({
  kind: 'spatial' as const,
  id,
  source: { elementType: 'image' as const, elementKey: id },
  props,
});
const scatter = (id: string, props: Record<string, unknown> = {}) =>
  new ScatterplotLayer({ id, data: [], getPosition: [0, 0], ...props });
const resolveScatter = (entry: { id: string }) => scatter(`runtime-${entry.id}`);

describe('render stack tree walking', () => {
  const stack = renderStackSchema.parse({
    schemaVersion: 2,
    entries: [
      {
        kind: 'group',
        id: 'hidden',
        visible: false,
        children: [image('image-hidden'), host('deck:hidden')],
      },
      {
        kind: 'group',
        id: 'faded',
        props: { opacity: 0.5 },
        children: [
          image('image-faded', { opacity: 0.8 }),
          host('deck:faded'),
          {
            kind: 'group',
            id: 'isolated',
            props: { isolate: true, opacity: 0.25 },
            children: [image('image-isolated'), host('deck:isolated')],
          },
        ],
      },
    ],
  });

  it('inherits visibility and pass-through opacity into layer inputs', () => {
    const { layers, layerOrder } = renderStackToLayerInputs(stack);

    expect(layerOrder).toEqual(['image-hidden', 'image-faded', 'image-isolated']);
    expect(layers['image-hidden']).toMatchObject({ visible: false });
    expect(layers['image-faded']).toMatchObject({ visible: true, opacity: 0.4 });
    // An isolated group's opacity belongs to its composite, not its members.
    expect(layers['image-isolated']).toMatchObject({ visible: true, opacity: 1 });
  });

  it('resolves only visible host entries, with pass-through opacity', () => {
    const resolved = resolveRenderStackHostLayers(stack, resolveScatter);

    expect(resolved.map((layer) => [layer.id, layer.props.opacity])).toEqual([
      ['deck:faded', 0.5],
      ['deck:isolated', 1],
    ]);
  });
});

describe('renderStackToDeckLayers', () => {
  const ids = (layers: Layer[]) => layers.map((layer) => layer.id);

  it('builds a host-only stack, wrapping an isolated multiply group', () => {
    const stack = renderStackSchema.parse({
      schemaVersion: 2,
      entries: [
        host('deck:under'),
        {
          kind: 'group',
          id: 'points',
          props: { blendMode: 'multiply', opacity: 0.5 },
          children: [host('deck:grey_scatter'), host('deck:scatter')],
        },
        host('deck:over'),
      ],
    });

    const layers = renderStackToDeckLayers(stack, { hostLayerResolver: resolveScatter });

    expect(ids(layers)).toEqual(['deck:under', 'points', 'deck:over']);
    const group = layers[1];
    expect(group).toBeInstanceOf(IsolatedGroupLayer);
    expect(group?.props).toMatchObject({ blendMode: 'multiply', opacity: 0.5 });
    const members = group instanceof IsolatedGroupLayer ? group.props.layers.flat() : [];
    expect(ids(members.filter((member) => member instanceof Layer))).toEqual([
      'deck:grey_scatter',
      'deck:scatter',
    ]);
  });

  it('adds no layer for a pass-through group, and multiplies its opacity', () => {
    const stack = renderStackSchema.parse({
      schemaVersion: 2,
      entries: [
        {
          kind: 'group',
          id: 'g',
          props: { opacity: 0.5 },
          children: [host('deck:a'), host('deck:b')],
        },
      ],
    });

    const layers = renderStackToDeckLayers(stack, { hostLayerResolver: resolveScatter });

    expect(layers.some((layer) => layer instanceof IsolatedGroupLayer)).toBe(false);
    expect(layers.map((layer) => [layer.id, layer.props.opacity])).toEqual([
      ['deck:a', 0.5],
      ['deck:b', 0.5],
    ]);
  });

  it('isolates with normal blending when only isolate is set, and nests', () => {
    const stack = renderStackSchema.parse({
      schemaVersion: 2,
      entries: [
        {
          kind: 'group',
          id: 'outer',
          props: { opacity: 0.5 },
          children: [
            {
              kind: 'group',
              id: 'inner',
              props: { isolate: true, opacity: 0.5 },
              children: [host('deck:a')],
            },
          ],
        },
      ],
    });

    const [inner] = renderStackToDeckLayers(stack, { hostLayerResolver: resolveScatter });

    expect(inner).toBeInstanceOf(IsolatedGroupLayer);
    expect(inner?.props).toMatchObject({ id: 'inner', blendMode: 'normal', opacity: 0.25 });
  });

  it('uses layers the caller built, and skips hidden or empty groups', () => {
    const stack = renderStackSchema.parse({
      schemaVersion: 2,
      entries: [
        image('image-a'),
        {
          kind: 'group',
          id: 'hidden',
          visible: false,
          props: { isolate: true },
          children: [image('image-b'), host('deck:hidden')],
        },
        { kind: 'group', id: 'empty', props: { isolate: true }, children: [] },
      ],
    });
    const built = scatter('image-a-#view#');
    const hiddenBuilt = scatter('image-b-#view#', { visible: false });
    const resolved: string[] = [];

    const layers = renderStackToDeckLayers(stack, {
      entryLayers: new Map([
        ['image-a', [built]],
        ['image-b', [hiddenBuilt]],
      ]),
      hostLayerResolver: (entry) => {
        resolved.push(entry.id);
        return resolveScatter(entry);
      },
    });

    // The hidden layer stays in the list, unwrapped, so deck keeps its state.
    expect(layers).toEqual([built, hiddenBuilt]);
    expect(resolved).toEqual([]);
  });
});

describe('shouldAutoFitSpatialView', () => {
  it('only auto-fits when the view is unset and renderable dimensions are available', () => {
    expect(
      shouldAutoFitSpatialView({
        autoFit: true,
        hasEnabledLayers: true,
        width: 600,
        height: 400,
        isBlocking: false,
        viewState: null,
      })
    ).toBe(true);

    expect(
      shouldAutoFitSpatialView({
        autoFit: true,
        hasEnabledLayers: true,
        width: 600,
        height: 400,
        isBlocking: false,
        viewState: { target: [0, 0], zoom: 0 },
      })
    ).toBe(false);
  });
});

describe('shouldRenderInternalTooltip', () => {
  it('disables internal tooltip rendering when renderTooltip is false', () => {
    expect(shouldRenderInternalTooltip(false)).toBe(false);
    expect(shouldRenderInternalTooltip(undefined)).toBe(true);
  });
});
