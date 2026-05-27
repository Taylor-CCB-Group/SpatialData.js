import { ScatterplotLayer } from 'deck.gl';
import type { Layer } from 'deck.gl';
import { describe, expect, it } from 'vitest';
import {
  VivSpatialViewer,
  normalizeVivLayers,
  normalizeVivZoom,
} from '../src/SpatialCanvas/VivSpatialViewer.js';

function makeImageLoader() {
  return [
    {
      constructor: { name: 'MockSource' },
      dtype: 'Uint16',
      labels: ['c', 'y', 'x'],
      shape: [1, 64, 64],
      tileSize: 64,
      getRaster: async () => ({
        data: new Uint16Array(64 * 64),
        width: 64,
        height: 64,
      }),
    },
  ];
}

describe('normalizeVivZoom', () => {
  it('uses the first zoom level when Viv returns an array', () => {
    expect(normalizeVivZoom([3, 2, 1])).toBe(3);
  });

  it('falls back to 0 when zoom is missing', () => {
    expect(normalizeVivZoom(undefined)).toBe(0);
  });
});

describe('normalizeVivLayers', () => {
  it('flattens nested layer arrays and ignores non-layer entries', () => {
    const layerA = new ScatterplotLayer({ id: 'layer-a', data: [], getPosition: [0, 0] });
    const layerB = new ScatterplotLayer({ id: 'layer-b', data: [], getPosition: [0, 0] });

    expect(normalizeVivLayers([null, [layerA, undefined], false, [[layerB]]])).toEqual([
      layerA,
      layerB,
    ]);
  });
});

describe('VivSpatialViewer image composition', () => {
  it('keeps multiple image layers distinct in the same Viv viewport', () => {
    const viewer = new VivSpatialViewer({
      width: 512,
      height: 512,
      viewState: { target: [32, 32], zoom: 1 },
      onViewStateChange: () => {},
      vivLayerProps: [
        {
          id: 'image:first',
          loader: makeImageLoader(),
          colors: [[255, 0, 0]],
          contrastLimits: [[0, 255]],
          channelsVisible: [true],
          selections: [{}],
          opacity: 0.5,
          visible: true,
        },
        {
          id: 'image:second',
          loader: makeImageLoader(),
          colors: [[0, 255, 0]],
          contrastLimits: [[0, 255]],
          channelsVisible: [true],
          selections: [{}],
          opacity: 0.5,
          visible: true,
        },
      ],
    });

    const testViewer = viewer as unknown as {
      _renderLayers: () => unknown;
      layerFilter: (args: { layer: Layer; viewport: { id: string } }) => boolean;
      viewId: string;
    };
    const layers = normalizeVivLayers(testViewer._renderLayers());
    const imageLayers = layers.filter((layer) => layer.id.includes('MockSource'));

    expect(imageLayers.map((layer) => layer.id)).toEqual([
      expect.stringContaining('image:first'),
      expect.stringContaining('image:second'),
    ]);
    expect(new Set(imageLayers.map((layer) => layer.id)).size).toBe(2);
    for (const layer of imageLayers) {
      expect(testViewer.layerFilter({ layer, viewport: { id: testViewer.viewId } })).toBe(true);
    }
  });

  it('interleaves image and deck layers by SpatialCanvas layer order', () => {
    const middleLayer = new ScatterplotLayer({
      id: 'shapes:middle',
      data: [],
      getPosition: [0, 0],
    });
    const viewer = new VivSpatialViewer({
      width: 512,
      height: 512,
      viewState: { target: [32, 32], zoom: 1 },
      onViewStateChange: () => {},
      layerOrder: ['image:first', 'shapes:middle', 'image:second'],
      extraLayers: [middleLayer],
      vivLayerProps: [
        {
          id: 'image:first',
          loader: makeImageLoader(),
          colors: [[255, 0, 0]],
          contrastLimits: [[0, 255]],
          channelsVisible: [true],
          selections: [{}],
          opacity: 0.5,
          visible: true,
        },
        {
          id: 'image:second',
          loader: makeImageLoader(),
          colors: [[0, 255, 0]],
          contrastLimits: [[0, 255]],
          channelsVisible: [true],
          selections: [{}],
          opacity: 0.5,
          visible: true,
        },
      ],
    });

    const testViewer = viewer as unknown as {
      _renderLayers: () => unknown;
    };
    const layers = normalizeVivLayers(testViewer._renderLayers());

    expect(layers.map((layer) => layer.id)).toEqual([
      expect.stringContaining('image:first'),
      expect.stringContaining('shapes:middle'),
      expect.stringContaining('image:second'),
    ]);
  });
});
