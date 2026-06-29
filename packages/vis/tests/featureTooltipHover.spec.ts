import { describe, expect, it, vi } from 'vitest';
import {
  getAggregateHoverPickDepth,
  normalizeDeckLayerId,
  resolveDeckPickLayerIds,
  resolveHoverFeatureTooltip,
} from '../src/SpatialCanvas/featureTooltipHover.js';

const LABELS_BITMASK_LAYER_ID = 'sub-layer-0-0-0-0,512,512,0-labels:mask-#spatial-view#-labels';

describe('featureTooltipHover', () => {
  it('normalizes viv-suffixed deck layer ids', () => {
    expect(normalizeDeckLayerId('shapes:cells-#image-a#')).toBe('shapes:cells');
  });

  it('aggregates tooltips from multiple layer picks', () => {
    const getFeatureTooltip = vi.fn((layerId: string) => {
      if (layerId === 'shapes:cells') {
        return {
          elementKey: 'cells',
          elementType: 'shapes',
          layerId,
          items: [{ label: 'element', value: 'shapes/cells' }],
        };
      }
      if (layerId === 'labels:mask') {
        return {
          elementKey: 'mask',
          elementType: 'labels',
          layerId,
          items: [{ label: 'element', value: 'labels/mask' }],
        };
      }
      return undefined;
    });

    const deck = {
      pickMultipleObjects: () => [
        {
          picked: true,
          x: 10,
          y: 20,
          layer: { id: 'labels:mask' },
          index: 0,
          object: {},
        },
        {
          picked: true,
          x: 10,
          y: 20,
          layer: { id: 'shapes:cells' },
          index: 1,
          object: {},
        },
      ],
    };

    const result = resolveHoverFeatureTooltip(
      { picked: true, x: 10, y: 20, layer: { id: 'shapes:cells' }, index: 1, object: {} },
      getFeatureTooltip,
      { deck }
    );

    expect(result?.sections).toHaveLength(2);
    expect(getFeatureTooltip).toHaveBeenCalledTimes(2);
  });

  it('caps aggregate picking depth to candidate tooltip layers', () => {
    expect(getAggregateHoverPickDepth(['shapes:cells', 'labels:mask'])).toBe(2);
    expect(getAggregateHoverPickDepth(['shapes:cells'], 6)).toBe(6);
  });

  it('passes candidate layer ids and capped depth to Deck aggregation', () => {
    const getFeatureTooltip = vi.fn((layerId: string) => ({
      elementKey: layerId,
      elementType: 'shapes' as const,
      layerId,
      items: [{ label: 'element', value: layerId }],
    }));
    const pickMultipleObjects = vi.fn(() => [
      {
        picked: true,
        x: 10,
        y: 20,
        layer: { id: 'shapes:cells' },
        index: 0,
        object: {},
      },
    ]);

    resolveHoverFeatureTooltip(
      { picked: true, x: 10, y: 20, layer: { id: 'shapes:cells' }, index: 1, object: {} },
      getFeatureTooltip,
      {
        deck: { pickMultipleObjects },
        pickLayerIds: ['shapes:cells', 'labels:mask'],
      }
    );

    expect(pickMultipleObjects).toHaveBeenCalledWith({
      x: 10,
      y: 20,
      radius: 4,
      depth: 2,
      layerIds: ['shapes:cells', 'labels:mask'],
    });
  });

  it('resolves logical pick layer ids to Viv-suffixed deck layer ids', () => {
    expect(
      resolveDeckPickLayerIds(
        {
          props: {
            layers: [
              { id: 'image-layer-image:imc' },
              { id: 'shapes:cells-#spatial-view#' },
              [{ id: 'labels:mask-#spatial-view#' }],
            ],
          },
          pickMultipleObjects: () => [],
        },
        ['shapes:cells', 'labels:mask']
      )
    ).toEqual(['shapes:cells-#spatial-view#', 'labels:mask-#spatial-view#']);
  });

  it('resolves logical label ids to flattened bitmask tile layer ids', () => {
    expect(
      resolveDeckPickLayerIds(
        {
          props: {
            layers: [{ id: 'labels:mask-#spatial-view#' }, { id: 'shapes:cells-#spatial-view#' }],
          },
          layerManager: {
            getLayers: () => [
              { id: 'shapes:cells-#spatial-view#' },
              { id: LABELS_BITMASK_LAYER_ID },
            ],
          },
          pickMultipleObjects: () => [],
        },
        ['shapes:cells', 'labels:mask']
      )
    ).toEqual([
      'labels:mask-#spatial-view#',
      'shapes:cells-#spatial-view#',
      LABELS_BITMASK_LAYER_ID,
    ]);
  });

  it('uses resolved deck layer ids for aggregation under Viv', () => {
    const getFeatureTooltip = vi.fn((layerId: string) => ({
      elementKey: layerId,
      elementType: 'shapes' as const,
      layerId,
      items: [{ label: 'element', value: layerId }],
    }));
    const pickMultipleObjects = vi.fn(() => [
      {
        picked: true,
        x: 10,
        y: 20,
        layer: { id: 'shapes:cells-#spatial-view#' },
        index: 0,
        object: {},
      },
      {
        picked: true,
        x: 10,
        y: 20,
        layer: { id: 'labels:mask-#spatial-view#' },
        index: 0,
        object: {},
      },
    ]);

    const result = resolveHoverFeatureTooltip(
      {
        picked: true,
        x: 10,
        y: 20,
        layer: { id: 'shapes:cells-#spatial-view#' },
        index: 0,
        object: {},
      },
      getFeatureTooltip,
      {
        deck: {
          props: {
            layers: [{ id: 'shapes:cells-#spatial-view#' }, { id: 'labels:mask-#spatial-view#' }],
          },
          pickMultipleObjects,
        },
        pickLayerIds: ['shapes:cells', 'labels:mask'],
      }
    );

    expect(pickMultipleObjects).toHaveBeenCalledWith({
      x: 10,
      y: 20,
      radius: 4,
      depth: 2,
      layerIds: ['shapes:cells-#spatial-view#', 'labels:mask-#spatial-view#'],
    });
    expect(result?.sections).toHaveLength(2);
    expect(getFeatureTooltip).toHaveBeenCalledWith('shapes:cells', expect.any(Object));
    expect(getFeatureTooltip).toHaveBeenCalledWith('labels:mask', expect.any(Object));
  });

  it('normalizes label bitmask sublayer picks back to the logical label layer', () => {
    const getFeatureTooltip = vi.fn((layerId: string) => ({
      elementKey: layerId,
      elementType: layerId.startsWith('labels:') ? ('labels' as const) : ('shapes' as const),
      layerId,
      items: [{ label: 'element', value: layerId }],
    }));
    const pickMultipleObjects = vi.fn(() => [
      {
        picked: true,
        x: 10,
        y: 20,
        layer: { id: 'shapes:cells-#spatial-view#' },
        index: 0,
        object: {},
      },
      {
        picked: true,
        x: 10,
        y: 20,
        layer: { id: LABELS_BITMASK_LAYER_ID },
        index: 0,
        object: { labelId: 7 },
      },
    ]);

    const result = resolveHoverFeatureTooltip(
      {
        picked: true,
        x: 10,
        y: 20,
        layer: { id: 'shapes:cells-#spatial-view#' },
        index: 0,
        object: {},
      },
      getFeatureTooltip,
      {
        deck: {
          layerManager: {
            getLayers: () => [
              { id: 'shapes:cells-#spatial-view#' },
              { id: LABELS_BITMASK_LAYER_ID },
            ],
          },
          pickMultipleObjects,
        },
        pickLayerIds: ['shapes:cells', 'labels:mask'],
      }
    );

    expect(result?.sections).toHaveLength(2);
    expect(getFeatureTooltip).toHaveBeenCalledWith('shapes:cells', expect.any(Object));
    expect(getFeatureTooltip).toHaveBeenCalledWith(
      'labels:mask',
      expect.objectContaining({ object: { labelId: 7 } })
    );
  });

  it('runs a targeted pick for a logical layer hidden behind duplicate same-layer picks', () => {
    const getFeatureTooltip = vi.fn((layerId: string) => ({
      elementKey: layerId,
      elementType: layerId.startsWith('labels:') ? ('labels' as const) : ('shapes' as const),
      layerId,
      items: [{ label: 'element', value: layerId }],
    }));
    const pickMultipleObjects = vi.fn(({ layerIds }: { layerIds?: string[] }) => {
      if (layerIds?.length === 1 && layerIds.includes(LABELS_BITMASK_LAYER_ID)) {
        return [
          {
            picked: true,
            x: 10,
            y: 20,
            layer: { id: LABELS_BITMASK_LAYER_ID },
            index: 0,
            object: { labelId: 7 },
          },
        ];
      }

      return [
        {
          picked: true,
          x: 10,
          y: 20,
          layer: { id: 'shapes:cells-#spatial-view#' },
          index: 0,
          object: { featureId: 'cell-a' },
        },
        {
          picked: true,
          x: 10,
          y: 20,
          layer: { id: 'shapes:cells-#spatial-view#' },
          index: 1,
          object: { featureId: 'cell-b' },
        },
      ];
    });

    const result = resolveHoverFeatureTooltip(
      {
        picked: true,
        x: 10,
        y: 20,
        layer: { id: 'shapes:cells-#spatial-view#' },
        index: 0,
        object: { featureId: 'cell-a' },
      },
      getFeatureTooltip,
      {
        deck: {
          layerManager: {
            getLayers: () => [
              { id: 'shapes:cells-#spatial-view#' },
              { id: LABELS_BITMASK_LAYER_ID },
            ],
          },
          pickMultipleObjects,
        },
        pickLayerIds: ['shapes:cells', 'labels:mask'],
      }
    );

    expect(pickMultipleObjects).toHaveBeenCalledTimes(2);
    expect(pickMultipleObjects).toHaveBeenLastCalledWith({
      x: 10,
      y: 20,
      radius: 4,
      depth: 1,
      layerIds: [LABELS_BITMASK_LAYER_ID],
    });
    expect(result?.sections).toHaveLength(2);
    expect(getFeatureTooltip).toHaveBeenCalledWith('shapes:cells', expect.any(Object));
    expect(getFeatureTooltip).toHaveBeenCalledWith(
      'labels:mask',
      expect.objectContaining({ object: { labelId: 7 } })
    );
  });

  it('recovers multiple occluded layers with a single batched supplemental pick', () => {
    const getFeatureTooltip = vi.fn((layerId: string) => ({
      elementKey: layerId,
      elementType: 'shapes' as const,
      layerId,
      items: [{ label: 'element', value: layerId }],
    }));
    // First (aggregate) pass sees only shapes:a; shapes:b and shapes:c are
    // "missing" and must be recovered without one readPixels per missing layer.
    const pickMultipleObjects = vi.fn(({ layerIds }: { layerIds?: string[] }) => {
      if (layerIds && layerIds.length === 3) {
        return [{ picked: true, x: 10, y: 20, layer: { id: 'shapes:a' }, index: 0, object: {} }];
      }
      return [
        { picked: true, x: 10, y: 20, layer: { id: 'shapes:b' }, index: 0, object: {} },
        { picked: true, x: 10, y: 20, layer: { id: 'shapes:c' }, index: 0, object: {} },
      ];
    });

    const result = resolveHoverFeatureTooltip(
      { picked: true, x: 10, y: 20, layer: { id: 'shapes:a' }, index: 0, object: {} },
      getFeatureTooltip,
      {
        deck: { pickMultipleObjects },
        pickLayerIds: ['shapes:a', 'shapes:b', 'shapes:c'],
      }
    );

    // One aggregate pass + one batched supplemental pass = 2 total (not 1 per
    // missing layer).
    expect(pickMultipleObjects).toHaveBeenCalledTimes(2);
    expect(pickMultipleObjects).toHaveBeenLastCalledWith({
      x: 10,
      y: 20,
      radius: 4,
      depth: 2,
      layerIds: ['shapes:b', 'shapes:c'],
    });
    expect(result?.sections).toHaveLength(3);
  });

  it('falls back to the original hover pick when filtered aggregation returns no picks', () => {
    const getFeatureTooltip = vi.fn(() => ({
      elementKey: 'cells',
      elementType: 'shapes' as const,
      layerId: 'shapes:cells',
      items: [{ label: 'element', value: 'shapes/cells' }],
    }));

    const result = resolveHoverFeatureTooltip(
      { picked: true, x: 10, y: 20, layer: { id: 'shapes:cells' }, index: 1, object: {} },
      getFeatureTooltip,
      {
        deck: { pickMultipleObjects: () => [] },
        pickLayerIds: ['shapes:cells'],
      }
    );

    expect(result?.items).toHaveLength(1);
    expect(getFeatureTooltip).toHaveBeenCalledWith('shapes:cells', expect.any(Object));
  });
});
