import { describe, expect, it } from 'vitest';

import { resolvePointsRenderStrategy } from '../src/pointsRenderStrategies.js';

describe('resolvePointsRenderStrategy', () => {
  it('selects morton and preloaded strategies by encoding kind', () => {
    expect(
      resolvePointsRenderStrategy({
        capabilities: {
          kind: 'morton-tiled',
          batchFormat: 'columnar-ndarray',
          supportsViewportTiles: true,
        },
        loadInBounds: async () => null,
      }).renderLayers
    ).toBeTypeOf('function');

    expect(
      resolvePointsRenderStrategy({
        capabilities: {
          kind: 'preloaded-columnar',
          batchFormat: 'columnar-ndarray',
          supportsViewportTiles: false,
        },
        loadAll: async () => ({
          format: 'columnar-ndarray',
          data: [[0], [0]],
          shape: [1],
          pointCount: 1,
        }),
        loadInBounds: async () => null,
      }).renderLayers
    ).toBeTypeOf('function');
  });
});
