import { describe, expect, it } from 'vitest';

import {
  completedSnapshotFromLoadResult,
  formatPointsTileDebugTooltip,
  isPointsTileDebugPickObject,
  POINTS_TILE_DEBUG_PICK_KIND,
  type PointsTileStatus,
  pointsTileDebugPolygonData,
  reduceTileDebugEntries,
  tileDebugStatusFillColor,
  tileDebugStatusLineColor,
  tileDebugStatusLineWidth,
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

/**
 * The overlay's polygons are what a hover picks, and the tooltip resolver recognises
 * them by `isPointsTileDebugPickObject`. That contract had no test and no production
 * caller, so the tooltip formatter sat fully written and unreachable — hovering a red
 * tile told you nothing. Pin the shape so the two ends cannot drift apart again.
 */
describe('tile debug pick objects', () => {
  const entry = {
    tileId: '1-2--1',
    index: { x: 1, y: 2, z: -1 },
    bbox: { minX: 512, minY: 512, maxX: 1024, maxY: 1024 },
    clippedBounds: null,
    status: 'error' as const,
    requestedAt: 1_000,
    errorMessage: 'Error: read failed',
  };

  it('produces polygons that the tooltip resolver accepts as picks', () => {
    const data = pointsTileDebugPolygonData([entry]).map((datum) => ({
      ...datum,
      kind: POINTS_TILE_DEBUG_PICK_KIND,
    }));

    expect(data).toHaveLength(1);
    expect(isPointsTileDebugPickObject(data[0])).toBe(true);
    expect(isPointsTileDebugPickObject({ entry })).toBe(false);
    expect(isPointsTileDebugPickObject(undefined)).toBe(false);
  });

  it('surfaces the error message a red tile cannot show on its own', () => {
    const tooltip = formatPointsTileDebugTooltip(
      entry,
      { inFlight: 1, loaded: 3, loadedPoints: 900, viewportTotal: 6 },
      2_000
    );

    expect(tooltip.title).toBe('Tile 1-2--1');
    expect(tooltip.items).toContainEqual({ label: 'status', value: 'error' });
    expect(tooltip.items).toContainEqual({ label: 'error', value: 'Error: read failed' });
  });
});

/**
 * The overlay only ever grew: `completedTilesById` is one of the sources the active
 * set is rebuilt from, and nothing pruned it. Pan or zoom away and every tile ever
 * loaded stayed painted — an `aborted` leftover among them being a dusty red rectangle
 * over ground the current tiles had since rendered, which reads as an error on a tile
 * whose data resolved. Observed live as 62 rectangles drawn for a 44-tile viewport,
 * the extra 18 at a zoom level the view had left.
 */
describe('forgetting tiles deck has unloaded', () => {
  const tile = {
    tileId: '1-2--1',
    index: { x: 1, y: 2, z: -1 },
    bbox: { left: 512, top: 1024, right: 1024, bottom: 512 },
  };
  const bounds = { minX: 512, minY: 512, maxX: 1024, maxY: 1024 };

  it('drops an unloaded tile from the overlay, aborted ones included', () => {
    const hooks = createTiledPointsDebugHooks(createTileDebugStore());
    const attempt = hooks.onTileLoadStart(tile);
    hooks.onTileLoadEnd(
      tile,
      { success: false, aborted: true, clippedBounds: bounds, errorMessage: 'aborted' },
      bounds,
      attempt
    );
    expect(hooks.getTileDebugEntries().map((e) => e.tileId)).toEqual([tile.tileId]);

    hooks.onTileUnloaded(tile.tileId);

    expect(hooks.getTileDebugEntries()).toEqual([]);
  });

  it('does not resurrect it from the last viewport list', () => {
    // The rebuild that follows every event unions the viewport tiles back in, so
    // forgetting a tile has to take it out of that list too or it returns as `pending`
    // and never leaves again — nothing is going to load it.
    const hooks = createTiledPointsDebugHooks(createTileDebugStore());
    hooks.onViewportTilesRequested([tile]);
    const attempt = hooks.onTileLoadStart(tile);
    hooks.onTileLoadEnd(
      tile,
      { success: true, clippedBounds: bounds, pointCount: 7 },
      bounds,
      attempt
    );

    hooks.onTileUnloaded(tile.tileId);

    expect(hooks.getTileDebugEntries()).toEqual([]);
  });

  it('ignores an unload for a tile it never knew about', () => {
    const hooks = createTiledPointsDebugHooks(createTileDebugStore());
    hooks.onTileUnloaded('9-9--9');
    expect(hooks.getTileDebugEntries()).toEqual([]);
  });
});

/**
 * `aborted` used to be a dusty red, one shade off `error`. Since the overlay keeps a
 * completed tile drawn until deck unloads it, an abandoned request could sit as a red
 * rectangle over ground that had loaded perfectly — reported as "a tile shows an error
 * even though the data resolved".
 *
 * Asserted as properties rather than exact RGB, so retuning the palette does not mean
 * rewriting the test; what must not change is that red means one thing.
 */
describe('overlay palette', () => {
  const statuses: PointsTileStatus[] = [
    'pending',
    'loading',
    'loaded',
    'empty',
    'error',
    'aborted',
  ];
  /**
   * Reads as red: red dominant over both others AND green low. The green guard is
   * what separates red from `loading`'s amber, which is also red-dominant but reads
   * as orange precisely because green is high.
   */
  const readsAsRed = ([r, g, b]: [number, number, number, number]) =>
    r > g + 50 && r > b + 50 && g < 130;

  it('makes error the only status that reads as red', () => {
    const red = statuses.filter(
      (status) =>
        readsAsRed(tileDebugStatusLineColor(status)) || readsAsRed(tileDebugStatusFillColor(status))
    );
    expect(red).toEqual(['error']);
  });

  it('gives every status a distinct outline', () => {
    const seen = statuses.map((status) => tileDebugStatusLineColor(status).join(','));
    expect(new Set(seen).size).toBe(statuses.length);
  });

  it('marks error out by weight too, not by hue alone', () => {
    // loaded-green against error-red is the classic red-green pair, so the outline
    // width carries the difference for anyone hue cannot. Opacity cannot do that job:
    // `loading` is also fully opaque, deliberately, so an in-flight tile stays legible.
    const widths = statuses.map((status) => tileDebugStatusLineWidth(status));
    const errorWidth = tileDebugStatusLineWidth('error');
    expect(Math.max(...widths)).toBe(errorWidth);
    expect(widths.filter((width) => width === errorWidth)).toHaveLength(1);
  });

  it('does not label an abort as an error in the tooltip', () => {
    // `status` already carries it. An "error" row reading "aborted" is the same
    // red-herring the palette had, in words.
    const aborted = completedSnapshotFromLoadResult(
      { success: false, aborted: true },
      { minX: 0, minY: 0, maxX: 512, maxY: 512 },
      2_000,
      1_000
    );
    expect(aborted.status).toBe('aborted');
    expect(aborted.errorMessage).toBeUndefined();
  });

  it('keeps aborted recessive — it is a cancelled request, not a failure', () => {
    expect(tileDebugStatusFillColor('aborted')[3]).toBeLessThan(
      tileDebugStatusFillColor('error')[3]
    );
    expect(tileDebugStatusLineColor('aborted')[3]).toBeLessThan(
      tileDebugStatusLineColor('error')[3]
    );
  });
});
