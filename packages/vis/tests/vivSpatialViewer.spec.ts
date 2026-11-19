import type { Layer } from '@deck.gl/core';
import { DeviceAdaptiveImageLayer } from '@spatialdata/layers';
import { describe, expect, it } from 'vitest';
import type { ImageLayerConfig } from '../src/SpatialCanvas/useLayerData.js';
import { VivSpatialViewer } from '../src/SpatialCanvas/VivSpatialViewer.js';
import { getVivId, vivImageLayers } from '../src/SpatialCanvas/vivImageLayers.js';

const baseConfig = {
  id: 'image-1',
  loader: [{ labels: ['y', 'x'], shape: [64, 64] }],
  colors: [[255, 255, 255]],
  contrastLimits: [[0, 255]],
  channelsVisible: [true],
  selections: [{}],
} satisfies ImageLayerConfig;

function vivPropsOf(layer: Layer | undefined): Record<string, unknown> {
  if (!(layer instanceof DeviceAdaptiveImageLayer)) {
    throw new Error('expected a DeviceAdaptiveImageLayer');
  }
  return layer.props.vivLayer.props;
}

function renderViewer(config: ImageLayerConfig): Layer[] {
  const viewer = new VivSpatialViewer({
    vivLayerProps: [config],
    width: 512,
    height: 512,
    viewState: { target: [0, 0], zoom: 0 },
    onViewStateChange: () => {},
  });
  return viewer
    ._renderLayers()
    .filter((layer): layer is Layer => layer instanceof DeviceAdaptiveImageLayer);
}

describe('vivImageLayers', () => {
  it('keys layers by config id and carries the view token in their ids', () => {
    const second = { ...baseConfig, id: 'image-2' };
    const layers = vivImageLayers([baseConfig, second], { viewId: '@shared' });

    expect([...layers.keys()]).toEqual(['image-1', 'image-2']);
    const ids = [...layers.values()].flat().map((layer) => layer.id);
    expect(ids).toHaveLength(2);
    for (const id of ids) {
      expect(id).toContain(getVivId('@shared'));
    }
    expect(new Set(ids).size).toBe(2);
  });
});

describe('VivSpatialViewer passthrough', () => {
  it('forwards vivProps into the Viv layer props', () => {
    const [layer] = renderViewer({
      ...baseConfig,
      vivProps: {
        brightness: [0.25],
        contrast: [0.75],
        customKey: 'host-owned',
      },
    });
    const props = vivPropsOf(layer);
    expect(props.brightness).toEqual([0.25]);
    expect(props.contrast).toEqual([0.75]);
    expect(props.customKey).toBe('host-owned');
    expect(props.colors).toEqual([[255, 255, 255]]);
  });

  it('passes alphaFromIntensity to Viv alongside the channel props', () => {
    const [layer] = renderViewer({
      ...baseConfig,
      alphaFromIntensity: { threshold: 0.2, gain: 3 },
    });
    expect(vivPropsOf(layer).alphaFromIntensity).toEqual({ threshold: 0.2, gain: 3 });
  });
});
