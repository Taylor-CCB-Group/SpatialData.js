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
  return { tileDebugEntries: [], completedTilesById: {}, loadingTileIds: [], tileHandlesById: {} };
}

function debugStateSignature(state: TiledPointsDebugState): string {
  const completedKeys = Object.keys(state.completedTilesById ?? {})
    .sort()
    .join(',');
  const loadingKeys = [...(state.loadingTileIds ?? [])].sort().join(',');
  const handleKeys = Object.keys(state.tileHandlesById ?? {})
    .sort()
    .join(',');
  return `${tileDebugEntriesSignature(state.tileDebugEntries)}|${loadingKeys}|${completedKeys}|${handleKeys}`;
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

export function createTiledPointsDebugHooks(store: TileDebugStore | undefined) {
  if (!store) {
    return {
      onViewportTilesRequested(_tiles: readonly PointsTileHandle[]) {},
      onTileLoadStart(_tile: PointsTileHandle) {},
      onTileLoadEnd(
        _tile: PointsTileHandle,
        _result: PointsTileLoadResult,
        _clipBounds: { minX: number; minY: number; maxX: number; maxY: number }
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
    onTileLoadStart(tile: PointsTileHandle) {
      store.update((state) => {
        const at = Date.now();
        const nextState: TiledPointsDebugState = {
          ...state,
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
    },
    onTileLoadEnd(
      tile: PointsTileHandle,
      result: PointsTileLoadResult,
      clipBounds: { minX: number; minY: number; maxX: number; maxY: number }
    ) {
      const at = Date.now();
      store.update((state) => {
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
