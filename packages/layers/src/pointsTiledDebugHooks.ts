import type { PointsLayer } from './PointsLayer.js';
import type { PointsTileLoadCallbacks } from './pointsTileLoadCallbacks.js';
import {
  reduceTileDebugEntries,
  tileDebugEntriesSignature,
  type PointsTileDebugEntry,
} from './pointsTileDebug.js';

export interface TiledPointsDebugState {
  tileDebugEntries: PointsTileDebugEntry[];
}

export function createTiledPointsDebugHooks(
  layer: PointsLayer,
  tileLoadCallbacks?: PointsTileLoadCallbacks
) {
  const updateDebugEntries = (updater: (entries: readonly PointsTileDebugEntry[]) => PointsTileDebugEntry[]) => {
    const current =
      ((layer.state as unknown as TiledPointsDebugState | undefined)?.tileDebugEntries) ?? [];
    const next = updater(current);
    layer.setState({ tileDebugEntries: next });
  };

  return {
    onViewportTilesRequested(tiles: Parameters<NonNullable<PointsTileLoadCallbacks['onViewportTilesRequested']>>[0]) {
      tileLoadCallbacks?.onViewportTilesRequested?.(tiles);
      updateDebugEntries((entries) =>
        reduceTileDebugEntries(entries, { type: 'viewport', tiles, at: Date.now() })
      );
    },
    onTileLoadStart(tile: Parameters<NonNullable<PointsTileLoadCallbacks['onTileLoadStart']>>[0]) {
      tileLoadCallbacks?.onTileLoadStart?.(tile);
      updateDebugEntries((entries) =>
        reduceTileDebugEntries(entries, { type: 'start', tile, at: Date.now() })
      );
    },
    onTileLoadEnd(
      tile: Parameters<NonNullable<PointsTileLoadCallbacks['onTileLoadEnd']>>[0],
      result: Parameters<NonNullable<PointsTileLoadCallbacks['onTileLoadEnd']>>[1],
      clipBounds: { minX: number; minY: number; maxX: number; maxY: number }
    ) {
      tileLoadCallbacks?.onTileLoadEnd?.(tile, result);
      updateDebugEntries((entries) =>
        reduceTileDebugEntries(entries, {
          type: 'end',
          tile,
          result,
          at: Date.now(),
          clipBounds,
        })
      );
    },
    getTileDebugEntries(): PointsTileDebugEntry[] {
      return ((layer.state as unknown as TiledPointsDebugState | undefined)?.tileDebugEntries) ?? [];
    },
    getTileDebugSignature(): string {
      return tileDebugEntriesSignature(
        ((layer.state as unknown as TiledPointsDebugState | undefined)?.tileDebugEntries) ?? []
      );
    },
  };
}
