import { describe, expect, it } from 'vitest';

import {
  completedSnapshotFromLoadResult,
  formatPointsTileDebugTooltip,
  reduceTileDebugEntries,
} from '../src/pointsTileDebug.js';

const sampleTile = {
  tileId: '1-2--1',
  index: { x: 1, y: 2, z: -1 },
  bbox: { left: 512, top: 1024, right: 1024, bottom: 512 },
};

const emptyViewportContext = {
  loadingTileIds: new Set<string>(),
  completedTilesById: new Map(),
  tileHandlesById: new Map(),
};

const sampleTile2 = {
  tileId: '3-4--1',
  index: { x: 3, y: 4, z: -1 },
  bbox: { left: 1536, top: 2048, right: 2048, bottom: 1536 },
};

describe('pointsTileDebug', () => {
  it('transitions tile status through viewport, start, and end events', () => {
    const at = 1_000;
    let entries = reduceTileDebugEntries([], {
      type: 'viewport',
      tiles: [sampleTile],
      at,
      context: {
        ...emptyViewportContext,
        tileHandlesById: new Map([[sampleTile.tileId, sampleTile]]),
      },
    });
    expect(entries[0]?.status).toBe('pending');

    entries = reduceTileDebugEntries(entries, { type: 'start', tile: sampleTile, at: at + 10 });
    expect(entries[0]?.status).toBe('loading');
    expect(entries[0]?.startedAt).toBe(at + 10);

    entries = reduceTileDebugEntries(entries, {
      type: 'end',
      tile: sampleTile,
      at: at + 100,
      clipBounds: { minX: 512, minY: 512, maxX: 1024, maxY: 1024 },
      result: { success: true, pointCount: 42, loadMode: 'row-groups' },
    });
    expect(entries[0]?.status).toBe('loaded');
    expect(entries[0]?.pointCount).toBe(42);
    expect(entries[0]?.completedAt).toBe(at + 100);
  });

  it('restores completed tiles after they re-enter the viewport', () => {
    const at = 1_000;
    const completedTilesById = new Map([
      [
        sampleTile.tileId,
        completedSnapshotFromLoadResult(
          { success: true, pointCount: 42, loadMode: 'row-groups' },
          { minX: 512, minY: 512, maxX: 1024, maxY: 1024 },
          at + 100,
          at + 10
        ),
      ],
    ]);

    const entries = reduceTileDebugEntries([], {
      type: 'viewport',
      tiles: [sampleTile],
      at: at + 200,
      context: {
        loadingTileIds: new Set(),
        completedTilesById,
        tileHandlesById: new Map([[sampleTile.tileId, sampleTile]]),
      },
    });

    expect(entries[0]?.status).toBe('loaded');
    expect(entries[0]?.pointCount).toBe(42);
  });

  it('includes loading and completed tiles not reported in the latest viewport event', () => {
    const at = 1_000;
    const completedTilesById = new Map([
      [
        sampleTile2.tileId,
        completedSnapshotFromLoadResult(
          { success: true, pointCount: 99, loadMode: 'row-groups' },
          { minX: 1536, minY: 1536, maxX: 2048, maxY: 2048 },
          at + 50,
          at + 10
        ),
      ],
    ]);

    const entries = reduceTileDebugEntries([], {
      type: 'viewport',
      tiles: [sampleTile],
      at: at + 100,
      context: {
        loadingTileIds: new Set([sampleTile.tileId]),
        completedTilesById,
        tileHandlesById: new Map([
          [sampleTile.tileId, sampleTile],
          [sampleTile2.tileId, sampleTile2],
        ]),
      },
    });

    expect(entries.map((entry) => entry.tileId).sort()).toEqual(
      [sampleTile.tileId, sampleTile2.tileId].sort()
    );
    expect(entries.find((entry) => entry.tileId === sampleTile.tileId)?.status).toBe('loading');
    expect(entries.find((entry) => entry.tileId === sampleTile2.tileId)?.pointCount).toBe(99);
  });

  it('formats tooltip with elapsed time for in-flight tiles', () => {
    const tooltip = formatPointsTileDebugTooltip(
      {
        tileId: sampleTile.tileId,
        index: sampleTile.index,
        bbox: { minX: 512, minY: 512, maxX: 1024, maxY: 1024 },
        clippedBounds: null,
        status: 'loading',
        requestedAt: 1_000,
        startedAt: 1_500,
      },
      { inFlight: 1, loaded: 0, loadedPoints: 0, viewportTotal: 3 },
      2_000
    );
    expect(tooltip.items.some((item) => item.label === 'elapsed' && item.value === '500ms')).toBe(
      true
    );
  });
});
