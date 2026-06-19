import { ScatterplotLayer } from 'deck.gl';
import { describe, expect, it } from 'vitest';
import {
  composeSpatialDeckLayers,
  shouldAutoFitSpatialView,
  shouldRenderInternalTooltip,
} from '../src/SpatialCanvas/SpatialCanvasViewer.js';
import {
  renderStackOrder,
  renderStackToLayerInputs,
  resolveRenderStackHostLayers,
  sortLayersByRenderStackOrder,
} from '../src/SpatialCanvas/renderStackAdapters.js';
import { renderStackSchema } from '@spatialdata/layers';

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

  it('uses group child ids as reserved ordering slots', () => {
    const stack = renderStackSchema.parse({
      entries: [
        {
          kind: 'group',
          id: 'group:blend',
          children: ['image-a', 'labels-a'],
        },
      ],
    });

    expect(renderStackOrder(stack, [])).toEqual(['image-a', 'labels-a']);
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
