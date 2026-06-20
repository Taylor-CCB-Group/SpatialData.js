import { describe, expect, it } from 'vitest';

import {
  aggregatePointsTileLoadProgress,
  createPointsTileLoadCallbacks,
  emptyPointsTileLoadProgress,
  isPointsTileLoading,
  pointsTileLoadingMessage,
} from '../src/SpatialCanvas/pointsTileProgress.js';

const sampleTile = {
  tileId: '0-0--1',
  index: { x: 0, y: 0, z: -1 },
  bbox: { left: 0, top: 512, right: 512, bottom: 0 },
};

describe('pointsTileProgress', () => {
  it('aggregates progress across layers', () => {
    const aggregate = aggregatePointsTileLoadProgress(
      new Map([
        ['a', { inFlight: 2, loaded: 1, viewportTotal: 4 }],
        ['b', { inFlight: 1, loaded: 3, viewportTotal: 6 }],
      ])
    );
    expect(aggregate).toEqual({ inFlight: 3, loaded: 4, viewportTotal: 10 });
  });

  it('reports loading while tiles are in flight', () => {
    expect(
      pointsTileLoadingMessage({ inFlight: 2, loaded: 1, viewportTotal: 6 })
    ).toBe('Loading points… (1/6 tiles)');
    expect(isPointsTileLoading({ inFlight: 2, loaded: 1, viewportTotal: 6 })).toBe(true);
  });

  it('clears the message when the viewport batch completes', () => {
    expect(
      pointsTileLoadingMessage({ inFlight: 0, loaded: 6, viewportTotal: 6 })
    ).toBeNull();
  });

  it('tracks tile lifecycle through callbacks', () => {
    let progress = emptyPointsTileLoadProgress();
    const callbacks = createPointsTileLoadCallbacks(
      () => progress,
      (next) => {
        progress = next;
      }
    );

    callbacks.onViewportTilesRequested?.([sampleTile, sampleTile]);
    expect(progress).toEqual({ inFlight: 0, loaded: 0, viewportTotal: 2 });

    callbacks.onTileLoadStart?.(sampleTile);
    callbacks.onTileLoadStart?.(sampleTile);
    expect(progress.inFlight).toBe(2);

    callbacks.onTileLoadEnd?.(sampleTile, { success: true, pointCount: 10 });
    expect(progress).toEqual({ inFlight: 1, loaded: 1, viewportTotal: 2 });

    callbacks.onTileLoadEnd?.(sampleTile, { success: true, pointCount: 0 });
    expect(progress).toEqual({ inFlight: 0, loaded: 2, viewportTotal: 2 });
    expect(pointsTileLoadingMessage(progress)).toBeNull();
  });
});
