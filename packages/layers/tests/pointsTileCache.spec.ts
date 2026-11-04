import { OrthographicViewport } from '@deck.gl/core';
import { _Tileset2D as Tileset2D } from '@deck.gl/geo-layers';
import { describe, expect, it } from 'vitest';
import { pointsZarrTiledStrategy } from '../src/mortonTiledStrategy.js';
import type { PointsLayer } from '../src/PointsLayer.js';

/**
 * Zooming back over levels already visited must not reload them. The tile cache used to
 * be sized as if every tile held the per-tile row target, which held 16 tiles; a zoom
 * across a few levels touches far more, so each zoom back evicted and refetched (and, in
 * a deck canvas, rebuilt every tile's layer).
 */
describe('tiled points cache', () => {
  const bounds = { minX: 0, minY: 0, maxX: 8192, maxY: 8192 };

  function tiledPoints() {
    let loads = 0;
    const resource = {
      element: { key: 'transcripts' },
      loader: {
        capabilities: {
          kind: 'points-zarr-tiled' as const,
          batchFormat: 'columnar-ndarray' as const,
          supportsViewportTiles: true,
          bounds,
          finestTileSize: 128,
        },
        loadInBounds: async () => {
          loads++;
          const n = 1_000;
          return {
            format: 'columnar-ndarray' as const,
            data: [new Float32Array(n), new Float32Array(n)],
            shape: [2, n],
            pointCount: n,
            featureCodes: new Uint32Array(n),
          };
        },
      },
    };
    // The strategy reads only these members of the composite.
    const layer = {
      props: { id: 'points:transcripts', visible: true, resource },
      subLayerProps: (sub: Record<string, unknown>) => ({
        ...sub,
        id: `points:transcripts-${sub.id}`,
      }),
    } as unknown as PointsLayer;
    const result = pointsZarrTiledStrategy.renderLayers(layer);
    const tileLayer = (Array.isArray(result) ? result[0] : result) as unknown as {
      props: ConstructorParameters<typeof Tileset2D>[0];
    };
    return { props: tileLayer.props, loadCount: () => loads };
  }

  /** Zoom from the coarsest level to the finest and back, letting each level load. */
  async function sweep(tileset: Tileset2D, minZoom: number, maxZoom: number) {
    const levels = [];
    for (let z = minZoom; z <= maxZoom; z++) levels.push(z);
    for (const z of [...levels, ...levels.reverse()]) {
      const viewport = new OrthographicViewport({
        width: 1024,
        height: 768,
        target: [3000, 5000, 0],
        zoom: z - 0.5,
      });
      tileset.update(viewport);
      // Loads are queued on a timer and resolve on the microtask queue.
      for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0));
      tileset.update(viewport);
    }
  }

  it('reloads nothing on a second zoom over the same levels', async () => {
    const { props, loadCount } = tiledPoints();
    const tileset = new Tileset2D(props);

    await sweep(tileset, props.minZoom ?? 0, props.maxZoom ?? 0);
    const firstSweep = loadCount();
    await sweep(tileset, props.minZoom ?? 0, props.maxZoom ?? 0);

    // The sweep is big enough to matter: it touches more tiles than the old cache held.
    expect(firstSweep).toBeGreaterThan(16);
    expect(loadCount()).toBe(firstSweep);
  });

  it('is a sweep a tile-count cache of 16 could not hold', async () => {
    // Guards the test above: with the old bound, the same sweep does reload.
    const { props, loadCount } = tiledPoints();
    const tileset = new Tileset2D({ ...props, maxCacheSize: 16, maxCacheByteSize: null });

    await sweep(tileset, props.minZoom ?? 0, props.maxZoom ?? 0);
    const firstSweep = loadCount();
    await sweep(tileset, props.minZoom ?? 0, props.maxZoom ?? 0);

    expect(loadCount()).toBeGreaterThan(firstSweep);
  });
});
