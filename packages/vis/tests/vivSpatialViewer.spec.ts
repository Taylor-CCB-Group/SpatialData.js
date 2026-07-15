import { Matrix4 } from '@math.gl/core';
import { describe, expect, it, vi } from 'vitest';
import type { ImageLayerConfig } from '../src/SpatialCanvas/useLayerData.js';
import { VivSpatialViewer } from '../src/SpatialCanvas/VivSpatialViewer.js';

describe('VivSpatialViewer passthrough', () => {
  it('forwards vivProps into detailView.getLayers props', () => {
    const getLayers = vi.fn(() => []);
    const viewer = new VivSpatialViewer({
      vivLayerProps: [
        {
          id: 'image-1',
          loader: { labels: ['y', 'x'], shape: [64, 64] },
          colors: [[255, 255, 255]],
          contrastLimits: [[0, 255]],
          channelsVisible: [true],
          selections: [{}],
          vivProps: {
            brightness: [0.25],
            contrast: [0.75],
            extensions: [{ name: 'demo-ext' }],
            customKey: 'host-owned',
          },
        } satisfies ImageLayerConfig,
      ],
      width: 512,
      height: 512,
      viewState: { target: [0, 0], zoom: 0 },
      onViewStateChange: () => {},
    });

    // @ts-expect-error - test hook into private detail view
    viewer.detailView = { getLayers };
    // @ts-expect-error - invoke private render path
    viewer._renderLayers();

    expect(getLayers).toHaveBeenCalled();
    const props = getLayers.mock.calls[0]?.[0]?.props as Record<string, unknown>;
    expect(props.brightness).toEqual([0.25]);
    expect(props.contrast).toEqual([0.75]);
    expect(props.extensions).toEqual([{ name: 'demo-ext' }]);
    expect(props.customKey).toBe('host-owned');
    expect(props.loader).toBeDefined();
    expect(props.colors).toEqual([[255, 255, 255]]);
  });
});
