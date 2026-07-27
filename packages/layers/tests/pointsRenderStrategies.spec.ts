import { describe, expect, it } from 'vitest';
import type { PointsLayer } from '../src/PointsLayer.js';
import { filterBatchSignature } from '../src/pointsFeatureCodes.js';
import { resolvePointsRenderStrategy } from '../src/pointsRenderStrategies.js';
import { preloadedScatterStrategy } from '../src/preloadedScatterStrategy.js';

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

describe('preloadedScatterStrategy — never shows the previous selection while a new one filters', () => {
  const codes = new Int32Array([0, 1, 0]);
  const preloadedBatch = {
    format: 'columnar-ndarray' as const,
    data: [new Float32Array([0, 1, 2]), new Float32Array([0, 1, 2])],
    shape: [2, 3] as [number, number],
    pointCount: 3,
    featureCodes: codes,
  };
  // A previously-computed filtered batch for gene {0} (2 of the 3 rows).
  const filteredForZero = {
    format: 'columnar-ndarray' as const,
    data: [new Float32Array([0, 2]), new Float32Array([0, 2])],
    shape: [2, 2] as [number, number],
    pointCount: 2,
    featureCodes: new Int32Array([0, 0]),
  };
  const drawnCount = (layer: unknown): number | undefined =>
    (layer as { props?: { data?: { length?: number } } } | null)?.props?.data?.length;

  function layerWith(props: Record<string, unknown>): PointsLayer {
    return {
      props: { id: 'points:x', visible: true, ...props },
      state: {
        preloadedBatch,
        filteredBatch: filteredForZero,
        filteredBatchSignature: filterBatchSignature([0], codes, undefined),
      },
    } as unknown as PointsLayer;
  }

  it('draws nothing (not the old gene) when the selection changed and the new filter is pending', () => {
    // Selection moved {0} → {1}; the stale filteredBatch still holds gene {0}. Reusing
    // it would draw gene 0 under a gene-1 selection — the "wrong gene shown" bug.
    const layer = layerWith({ featureCodes: [1], preloadedFeatureCodes: codes });
    expect(preloadedScatterStrategy.renderLayers(layer)).toBeNull();
  });

  it('reuses the previous filtered batch when only the render cap moved (same genes)', () => {
    // Same selection {0}, only renderCap differs → the full signature changed but the
    // GENE signature did not, so keeping the stale batch on screen is correct (no flash).
    const layer = layerWith({ featureCodes: [0], preloadedFeatureCodes: codes, renderCap: 100 });
    const result = preloadedScatterStrategy.renderLayers(layer);
    expect(drawnCount(Array.isArray(result) ? result[0] : result)).toBe(2);
  });

  it('falls back to the full batch for the "all features" view, not the stale selection', () => {
    // No selection: draw everything (3 rows), never the previous {0} filtered batch.
    const layer = layerWith({ featureCodes: undefined, preloadedFeatureCodes: codes });
    const result = preloadedScatterStrategy.renderLayers(layer);
    expect(drawnCount(Array.isArray(result) ? result[0] : result)).toBe(3);
  });
});
