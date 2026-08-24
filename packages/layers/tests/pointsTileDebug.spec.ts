import { describe, expect, it } from 'vitest';

import {
  completedSnapshotFromLoadResult,
  formatPointsTileDebugTooltip,
  reduceTileDebugEntries,
} from '../src/pointsTileDebug.js';
import { createTileDebugStore, createTiledPointsDebugHooks } from '../src/pointsTiledDebugHooks.js';

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

/**
 * Two loads for one tile can be in flight at once: deck restarts a tile whenever
 * `needsReload` is set — after an abort, or when a `getTileData` update trigger
 * changes, which the feature filter does — and `loadData` does not await the attempt
 * it replaces. deck compares a `_loaderId` after its own await and throws the loser's
 * result away; these hooks run inside `getTileData`, before that check, so they need
 * the same guard or the loser reports over the winner.
 */
describe('overlapping loads for one tile', () => {
  const tile = {
    tileId: '1-2--1',
    index: { x: 1, y: 2, z: -1 },
    bbox: { left: 512, top: 1024, right: 1024, bottom: 512 },
  };
  const bounds = { minX: 512, minY: 512, maxX: 1024, maxY: 1024 };
  const ok = { success: true as const, clippedBounds: bounds, pointCount: 4242 };
  const failed = {
    success: false as const,
    aborted: false,
    clippedBounds: bounds,
    errorMessage: 'boom',
  };
  const statusOf = (hooks: ReturnType<typeof createTiledPointsDebugHooks>) =>
    hooks.getTileDebugEntries().find((entry) => entry.tileId === tile.tileId);

  it('ignores a superseded load that fails after the replacement succeeded', () => {
    const hooks = createTiledPointsDebugHooks(createTileDebugStore());
    const first = hooks.onTileLoadStart(tile);
    const second = hooks.onTileLoadStart(tile);

    hooks.onTileLoadEnd(tile, ok, bounds, second);
    // The abandoned load rejects last. Painting the tile red here is the reported bug:
    // deck is holding the good content from `second`.
    hooks.onTileLoadEnd(tile, failed, bounds, first);

    expect(statusOf(hooks)?.status).toBe('loaded');
    expect(statusOf(hooks)?.pointCount).toBe(4242);
    expect(statusOf(hooks)?.errorMessage).toBeUndefined();
  });

  it('ignores a superseded load that succeeds late, so a live one still reads as loading', () => {
    // The mirror case, and the reason the guard is not just "never overwrite an error":
    // a stale SUCCESS landing while the replacement is still in flight would claim the
    // tile is done when nothing has drawn it.
    const hooks = createTiledPointsDebugHooks(createTileDebugStore());
    const first = hooks.onTileLoadStart(tile);
    hooks.onTileLoadStart(tile);

    hooks.onTileLoadEnd(tile, ok, bounds, first);

    expect(statusOf(hooks)?.status).toBe('loading');
  });

  it('still records the outcome of a load that was never superseded', () => {
    const hooks = createTiledPointsDebugHooks(createTileDebugStore());
    const only = hooks.onTileLoadStart(tile);

    hooks.onTileLoadEnd(tile, failed, bounds, only);

    expect(statusOf(hooks)?.status).toBe('error');
    expect(statusOf(hooks)?.errorMessage).toBe('boom');
  });
});
