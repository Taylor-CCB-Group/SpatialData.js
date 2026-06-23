import { describe, expect, it } from 'vitest';
import { mergeLayerChannelState } from '../src/layerChannelState';

describe('mergeLayerChannelState', () => {
  it('derives stable channel ids from layer id when omitted', () => {
    const merged = mergeLayerChannelState({}, undefined, 'image-morphology');
    expect(merged.channelIds).toEqual(['image-morphology:ch:0']);
  });

  it('preserves explicit channel ids', () => {
    const merged = mergeLayerChannelState(
      { channelIds: ['a', 'b'], colors: [[1, 2, 3], [4, 5, 6]] },
      undefined,
      'layer-1'
    );
    expect(merged.channelIds).toEqual(['a', 'b']);
    expect(merged.channelCount).toBe(2);
  });

  it('merges config overrides with loader defaults', () => {
    const merged = mergeLayerChannelState(
      { channelsVisible: [false] },
      {
        colors: [[255, 0, 0]],
        contrastLimits: [[0, 1000]],
        channelsVisible: [true],
        selections: [{ c: 1 }],
      },
      'layer-1'
    );
    expect(merged.colors[0]).toEqual([255, 0, 0]);
    expect(merged.channelsVisible[0]).toBe(false);
    expect(merged.contrastLimits[0]).toEqual([0, 1000]);
  });

  it('pads parallel arrays to channel count', () => {
    const merged = mergeLayerChannelState(
      {
        colors: [[1, 2, 3], [4, 5, 6]],
        contrastLimits: [[0, 1]],
      },
      undefined,
      'layer-1'
    );
    expect(merged.channelCount).toBe(2);
    expect(merged.contrastLimits).toHaveLength(2);
    expect(merged.channelsVisible).toHaveLength(2);
  });

  it('clamps selections to axis sizes when provided', () => {
    const merged = mergeLayerChannelState(
      { selections: [{ c: 99, z: 99 }] },
      {
        selectionAxisSizes: { c: 2, z: 3 },
        selections: [{ c: 0, z: 0 }],
      },
      'layer-1'
    );
    expect(merged.selections[0]?.c).toBe(1);
    expect(merged.selections[0]?.z).toBe(2);
  });
});
