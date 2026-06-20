import type { PointsTileHandle, TiledPointsDebugState } from '@spatialdata/layers';
import { describe, expect, it } from 'vitest';

import {
  aggregatePointsTileLoadProgress,
  isPointsTileLoading,
  pointsTileLoadProgressFromDebugState,
  pointsTileLoadingMessage,
} from '../src/SpatialCanvas/pointsTileProgress.js';

const sampleTile: PointsTileHandle = {
  tileId: '0-0--1',
  index: { x: 0, y: 0, z: -1 },
  bbox: { left: 0, top: 512, right: 512, bottom: 0 },
};

const otherTile: PointsTileHandle = {
  tileId: '1-0--1',
  index: { x: 1, y: 0, z: -1 },
  bbox: { left: 512, top: 512, right: 1024, bottom: 0 },
};

function debugState(overrides: Partial<TiledPointsDebugState>): TiledPointsDebugState {
  return {
    tileDebugEntries: [],
    completedTilesById: {},
    loadingTileIds: [],
    tileHandlesById: {},
    ...overrides,
  };
}

describe('pointsTileProgress', () => {
  it('aggregates progress across layers', () => {
    const aggregate = aggregatePointsTileLoadProgress(
      new Map([
        ['a', { inFlight: 2, loaded: 1, loadedPoints: 100, viewportTotal: 4 }],
        ['b', { inFlight: 1, loaded: 3, loadedPoints: 250, viewportTotal: 6 }],
      ])
    );
    expect(aggregate).toEqual({
      inFlight: 3,
      loaded: 4,
      loadedPoints: 350,
      viewportTotal: 10,
    });
  });

  it('reports loading while tiles are in flight', () => {
    expect(
      pointsTileLoadingMessage({ inFlight: 2, loaded: 1, loadedPoints: 42, viewportTotal: 6 })
    ).toBe('Loading points… (1/6 tiles, 42 points)');
    expect(
      isPointsTileLoading({ inFlight: 2, loaded: 1, loadedPoints: 42, viewportTotal: 6 })
    ).toBe(true);
  });

  it('includes zero loaded points while later tiles are still loading', () => {
    expect(
      pointsTileLoadingMessage({ inFlight: 1, loaded: 1, loadedPoints: 0, viewportTotal: 2 })
    ).toBe('Loading points… (1/2 tiles, 0 points)');
  });

  it('clears stale viewport messages when nothing is in flight', () => {
    expect(
      pointsTileLoadingMessage({ inFlight: 0, loaded: 0, loadedPoints: 0, viewportTotal: 4 })
    ).toBeNull();
    expect(
      pointsTileLoadingMessage({ inFlight: 0, loaded: 4, loadedPoints: 900, viewportTotal: 4 })
    ).toBeNull();
  });

  it('derives loaded and point totals from current viewport debug state', () => {
    const progress = pointsTileLoadProgressFromDebugState(
      debugState({
        lastViewportTiles: [sampleTile, otherTile],
        loadingTileIds: [otherTile.tileId],
        completedTilesById: {
          [sampleTile.tileId]: {
            status: 'loaded',
            pointCount: 10,
            clippedBounds: null,
            completedAt: 10,
          },
        },
      })
    );
    expect(progress).toEqual({ inFlight: 1, loaded: 1, loadedPoints: 10, viewportTotal: 2 });
  });

  it('counts cached empty tiles as loaded after viewport refresh', () => {
    const progress = pointsTileLoadProgressFromDebugState(
      debugState({
        lastViewportTiles: [sampleTile],
        completedTilesById: {
          [sampleTile.tileId]: {
            status: 'empty',
            pointCount: 0,
            clippedBounds: null,
            completedAt: 10,
          },
        },
      })
    );
    expect(progress).toEqual({ inFlight: 0, loaded: 1, loadedPoints: 0, viewportTotal: 1 });
  });

  it('does not let stale completed tiles inflate the current viewport total', () => {
    const progress = pointsTileLoadProgressFromDebugState(
      debugState({
        lastViewportTiles: [sampleTile],
        completedTilesById: {
          [sampleTile.tileId]: {
            status: 'loaded',
            pointCount: 10,
            clippedBounds: null,
            completedAt: 10,
          },
          [otherTile.tileId]: {
            status: 'loaded',
            pointCount: 20,
            clippedBounds: null,
            completedAt: 10,
          },
        },
      })
    );
    expect(progress).toEqual({ inFlight: 0, loaded: 1, loadedPoints: 10, viewportTotal: 1 });
  });
});
