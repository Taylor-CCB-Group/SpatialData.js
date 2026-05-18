import { ScatterplotLayer } from 'deck.gl';
import { describe, expect, it } from 'vitest';
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
