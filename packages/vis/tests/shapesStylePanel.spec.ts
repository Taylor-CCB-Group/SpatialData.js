import { describe, expect, it } from 'vitest';

import { formatShapesGeometryKindLabel } from '../src/SpatialCanvas/ShapesStylePanel.js';

describe('formatShapesGeometryKindLabel', () => {
  it('maps geometry kinds to display labels', () => {
    expect(formatShapesGeometryKindLabel('polygon')).toBe('polygons');
    expect(formatShapesGeometryKindLabel('circle')).toBe('circles');
    expect(formatShapesGeometryKindLabel('point')).toBe('points');
  });
});
