import { ScatterplotLayer } from 'deck.gl';
import { describe, expect, it } from 'vitest';
import { normalizeVivLayers, normalizeVivZoom } from '../src/SpatialCanvas/VivSpatialViewer.js';

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
