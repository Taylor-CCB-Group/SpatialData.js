import {
  completedSnapshotFromLoadResult,
  type PointsTileCompletedSnapshot,
  type PointsTileDebugEntry,
  reduceTileDebugEntries,
  tileDebugEntriesSignature,
} from './pointsTileDebug.js';
import type { PointsTileHandle, PointsTileLoadResult } from './pointsTileLoadCallbacks.js';

export interface TiledPointsDebugState {
  tileDebugEntries: PointsTileDebugEntry[];
  /**
   * Current load attempt per tile — the guard against a superseded request
   * reporting over the one that replaced it. See {@link createTiledPointsDebugHooks}.
   */
  attemptByTileId?: Record<string, number>;
  completedTilesById?: Record<string, PointsTileCompletedSnapshot>;
  loadingTileIds?: string[];
  lastViewportTiles?: readonly PointsTileHandle[];
  tileHandlesById?: Record<string, PointsTileHandle>;
}

function rememberTileHandle(
  state: TiledPointsDebugState,
  tile: PointsTileHandle
): Record<string, PointsTileHandle> {
  return { ...(state.tileHandlesById ?? {}), [tile.tileId]: tile };
}

function rebuildActiveDebugEntries(
  entries: readonly PointsTileDebugEntry[],
  state: TiledPointsDebugState,
  at: number
): PointsTileDebugEntry[] {
  return reduceTileDebugEntries(entries, {
    type: 'viewport',
    tiles: state.lastViewportTiles ?? [],
    at,
    context: {
      loadingTileIds: new Set(state.loadingTileIds ?? []),
      completedTilesById: new Map(Object.entries(state.completedTilesById ?? {})),
      tileHandlesById: new Map(Object.entries(state.tileHandlesById ?? {})),
    },
  });
}

export interface TileDebugStore {
  getState(): TiledPointsDebugState;
  update(updater: (state: TiledPointsDebugState) => TiledPointsDebugState): void;
}

function emptyDebugState(): TiledPointsDebugState {
  return {
    tileDebugEntries: [],
    completedTilesById: {},
    loadingTileIds: [],
    tileHandlesById: {},
    attemptByTileId: {},
  };
}

function debugStateSignature(state: TiledPointsDebugState): string {
  const completedKeys = Object.keys(state.completedTilesById ?? {})
    .sort()
    .join(',');
  const loadingKeys = [...(state.loadingTileIds ?? [])].sort().join(',');
  const handleKeys = Object.keys(state.tileHandlesById ?? {})
    .sort()
    .join(',');
  const attempts = Object.entries(state.attemptByTileId ?? {})
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([tileId, attempt]) => `${tileId}#${attempt}`)
    .join(',');
  return `${tileDebugEntriesSignature(state.tileDebugEntries)}|${loadingKeys}|${completedKeys}|${handleKeys}|${attempts}`;
}

export function createTileDebugStore(onChange?: () => void): TileDebugStore {
  let state = emptyDebugState();
  return {
    getState() {
      return state;
    },
    update(updater) {
      const next = updater(state);
      if (debugStateSignature(state) === debugStateSignature(next)) {
        return;
      }
      state = next;
      onChange?.();
    },
  };
}

/**
 * Tile-status hooks for the debug overlay.
 *
 * **Loads for one tile can overlap, and the loser must not report over the winner.**
 * deck restarts a tile whenever `needsReload` is set — after an abort, or after a
 * `getTileData` update trigger changes (the feature filter does this) — and
 * `Tile2DHeader.loadData` does NOT await the attempt it is replacing. The old
 * `getTileData` promise is still running, so two are in flight against one tile id.
 *
 * deck guards its own state against that with a `_loaderId` compared after the await;
 * these hooks are called from *inside* `getTileData`, upstream of that check, so
 * without a guard of their own the loser's outcome lands in the store. When the loser
 * rejects last, the overlay paints a tile red that deck is holding good content for —
 * which is the whole of the "error on a tile whose data resolved" report.
 *
 * So {@link onTileLoadStart} returns an attempt id and {@link onTileLoadEnd} requires
 * it back; a report whose id is no longer current is dropped. The id is a required
 * parameter rather than an optional one on purpose: forgetting to pass it should not
 * silently reinstate the race.
 */
export function createTiledPointsDebugHooks(store: TileDebugStore | undefined) {
  if (!store) {
    return {
      onViewportTilesRequested(_tiles: readonly PointsTileHandle[]) {},
      onTileLoadStart(_tile: PointsTileHandle): number {
        return 0;
      },
      onTileLoadEnd(
        _tile: PointsTileHandle,
        _result: PointsTileLoadResult,
        _clipBounds: { minX: number; minY: number; maxX: number; maxY: number },
        _attempt: number
      ) {},
      getTileDebugEntries(): PointsTileDebugEntry[] {
        return [];
      },
      getTileDebugSignature(): string {
        return '';
      },
    };
  }

  return {
    onViewportTilesRequested(tiles: readonly PointsTileHandle[]) {
      store.update((state) => {
        const at = Date.now();
        const tileHandlesById = { ...(state.tileHandlesById ?? {}) };
        for (const tile of tiles) {
          tileHandlesById[tile.tileId] = tile;
        }
        const nextState: TiledPointsDebugState = {
          ...state,
          lastViewportTiles: tiles,
          tileHandlesById,
        };
        return {
          ...nextState,
          tileDebugEntries: rebuildActiveDebugEntries(state.tileDebugEntries, nextState, at),
        };
      });
    },
    onTileLoadStart(tile: PointsTileHandle): number {
      let attempt = 0;
      store.update((state) => {
        const at = Date.now();
        attempt = (state.attemptByTileId?.[tile.tileId] ?? 0) + 1;
        const nextState: TiledPointsDebugState = {
          ...state,
          attemptByTileId: { ...(state.attemptByTileId ?? {}), [tile.tileId]: attempt },
          tileHandlesById: rememberTileHandle(state, tile),
          loadingTileIds: [...new Set([...(state.loadingTileIds ?? []), tile.tileId])],
          completedTilesById: Object.fromEntries(
            Object.entries(state.completedTilesById ?? {}).filter(
              ([tileId]) => tileId !== tile.tileId
            )
          ),
        };
        const afterStart = reduceTileDebugEntries(state.tileDebugEntries, {
          type: 'start',
          tile,
          at,
        });
        return {
          ...nextState,
          tileDebugEntries: rebuildActiveDebugEntries(afterStart, nextState, at),
        };
      });
      return attempt;
    },
    onTileLoadEnd(
      tile: PointsTileHandle,
      result: PointsTileLoadResult,
      clipBounds: { minX: number; minY: number; maxX: number; maxY: number },
      attempt: number
    ) {
      const at = Date.now();
      store.update((state) => {
        const current = state.attemptByTileId?.[tile.tileId];
        if (current !== undefined && attempt !== current) {
          // A superseded load reporting in. Returning `state` unchanged leaves the
          // signature equal, so the store does not even notify.
          return state;
        }
        const loadingTileIds = (state.loadingTileIds ?? []).filter(
          (tileId) => tileId !== tile.tileId
        );
        const completedTilesById = { ...(state.completedTilesById ?? {}) };
        const startedAt =
          state.tileDebugEntries.find((entry) => entry.tileId === tile.tileId)?.startedAt ?? at;
        completedTilesById[tile.tileId] = completedSnapshotFromLoadResult(
          result,
          clipBounds,
          at,
          startedAt
        );
        const nextState: TiledPointsDebugState = {
          ...state,
          tileHandlesById: rememberTileHandle(state, tile),
          loadingTileIds,
          completedTilesById,
        };
        return {
          ...nextState,
          tileDebugEntries: rebuildActiveDebugEntries(state.tileDebugEntries, nextState, at),
        };
      });
    },
    getTileDebugEntries(): PointsTileDebugEntry[] {
      return store.getState().tileDebugEntries;
    },
    getTileDebugSignature(): string {
      return tileDebugEntriesSignature(store.getState().tileDebugEntries);
    },
  };
}
