import { describe, expect, it, vi } from 'vitest';
import {
  getAggregateHoverPickDepth,
  normalizeDeckLayerId,
  resolveHoverFeatureTooltip,
} from '../src/SpatialCanvas/featureTooltipHover.js';

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
});
