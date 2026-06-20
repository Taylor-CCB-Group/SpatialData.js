import { describe, expect, it } from 'vitest';

import {
  MIN_POINT_SIZE_SCALE,
  POINT_SIZE_ZOOM_REFERENCE,
  zoomScaledPointSize,
} from '../src/SpatialCanvas/renderers/pointsRenderer.js';

describe('zoomScaledPointSize', () => {
  it('returns base size at the reference zoom', () => {
    expect(zoomScaledPointSize(4, POINT_SIZE_ZOOM_REFERENCE)).toBe(4);
  });

  it('shrinks points when zoomed out', () => {
    expect(zoomScaledPointSize(4, -2)).toBe(1);
  });

  it('does not grow beyond the configured size when zoomed in', () => {
    expect(zoomScaledPointSize(4, 4)).toBe(4);
  });

  it('clamps to the minimum scale when zoomed far out', () => {
    expect(zoomScaledPointSize(4, -10)).toBe(4 * MIN_POINT_SIZE_SCALE);
  });

  it('returns base size when zoom is unavailable', () => {
    expect(zoomScaledPointSize(3, null)).toBe(3);
    expect(zoomScaledPointSize(3, undefined)).toBe(3);
  });
});
