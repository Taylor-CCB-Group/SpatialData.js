import { describe, expect, it } from 'vitest';

import { resolvePointsRenderStrategy } from '../src/pointsRenderStrategies.js';
import { preloadedScatterStrategy } from '../src/preloadedScatterStrategy.js';
import type { PointsLayer } from '../src/PointsLayer.js';

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

describe('preloadedScatterStrategy sublayer id', () => {
  // Regression: the preloaded strategy used to pass the composite's own id
  // straight to its ScatterplotLayer sublayer. A sublayer sharing its parent
  // composite's id makes deck.gl re-initialise an already-initialised layer
  // (`assert(!this.internalState)`), flooding the console every frame. The
  // sublayer id must be namespaced (`<compositeId>-scatter`), matching the
  // morton strategy.
  it('namespaces the scatter sublayer id below the composite id', () => {
    const compositeId = 'points:transcripts';
    const batch = {
      format: 'columnar-ndarray' as const,
      data: [new Float32Array([0, 1]), new Float32Array([0, 1])],
      shape: [2, 2],
      pointCount: 2,
    };
    const fakeLayer = {
      props: { id: compositeId, visible: true },
      state: { preloadedBatch: batch },
    } as unknown as PointsLayer;

    const result = preloadedScatterStrategy.renderLayers(fakeLayer);
    const layer = (Array.isArray(result) ? result[0] : result) as { id: string } | null;
    expect(layer).toBeTruthy();
    expect(layer?.id).toBe(`${compositeId}-scatter`);
    expect(layer?.id).not.toBe(compositeId);
  });
});
