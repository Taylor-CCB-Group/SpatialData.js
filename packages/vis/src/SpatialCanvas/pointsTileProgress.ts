import type { PointsTileHandle, PointsTileLoadResult } from '@spatialdata/layers';

export interface PointsTileLoadProgress {
  /** Tiles currently fetching data. */
  inFlight: number;
  /** Tiles finished in the current viewport batch. */
  loaded: number;
  /** Points loaded across finished tiles in the current viewport batch. */
  loadedPoints: number;
  /** Tiles deck.gl requested for the current viewport. */
  viewportTotal: number;
}

export type { PointsTileHandle, PointsTileLoadResult };

export interface PointsTileLoadCallbacks {
  onViewportTilesRequested?: (tiles: readonly PointsTileHandle[]) => void;
  onTileLoadStart?: (tile: PointsTileHandle) => void;
  onTileLoadEnd?: (tile: PointsTileHandle, result: PointsTileLoadResult) => void;
}

interface TileLoadTracker {
  viewportTileIds: Set<string>;
  loadingTileIds: Set<string>;
  loadedTileIds: Set<string>;
  pointCountByTileId: Map<string, number>;
}

function derivePointsTileLoadProgress(tracker: TileLoadTracker): PointsTileLoadProgress {
  let loaded = 0;
  let inFlight = 0;
  let loadedPoints = 0;
  for (const tileId of tracker.viewportTileIds) {
    if (tracker.loadingTileIds.has(tileId)) {
      inFlight += 1;
    }
    if (tracker.loadedTileIds.has(tileId)) {
      loaded += 1;
      loadedPoints += tracker.pointCountByTileId.get(tileId) ?? 0;
    }
  }
  return {
    viewportTotal: tracker.viewportTileIds.size,
    loaded,
    inFlight,
    loadedPoints,
  };
}

export function emptyPointsTileLoadProgress(): PointsTileLoadProgress {
  return { inFlight: 0, loaded: 0, loadedPoints: 0, viewportTotal: 0 };
}

export function aggregatePointsTileLoadProgress(
  progressByLayer: ReadonlyMap<string, PointsTileLoadProgress>
): PointsTileLoadProgress {
  let inFlight = 0;
  let loaded = 0;
  let loadedPoints = 0;
  let viewportTotal = 0;
  for (const progress of progressByLayer.values()) {
    inFlight += progress.inFlight;
    loaded += progress.loaded;
    loadedPoints += progress.loadedPoints;
    viewportTotal += progress.viewportTotal;
  }
  return { inFlight, loaded, loadedPoints, viewportTotal };
}

function formatLoadedPointCount(pointCount: number): string {
  return pointCount.toLocaleString();
}

export function pointsTileLoadingMessage(progress: PointsTileLoadProgress): string | null {
  const { inFlight, loaded, loadedPoints, viewportTotal } = progress;
  const awaitingViewport =
    viewportTotal > 0 && loaded < viewportTotal && inFlight === 0;
  if (inFlight <= 0 && !awaitingViewport) {
    return null;
  }
  const pointsSuffix =
    loadedPoints > 0 ? `, ${formatLoadedPointCount(loadedPoints)} points` : '';
  const message =
    viewportTotal > 0
      ? `Loading points… (${loaded}/${viewportTotal} tiles${pointsSuffix})`
      : inFlight > 0
        ? 'Loading points…'
        : null;
  return message;
}

export function isPointsTileLoading(progress: PointsTileLoadProgress): boolean {
  return pointsTileLoadingMessage(progress) !== null;
}

export function createPointsTileLoadCallbacks(
  _getProgress: () => PointsTileLoadProgress,
  setProgress: (progress: PointsTileLoadProgress) => void
): PointsTileLoadCallbacks {
  const tracker: TileLoadTracker = {
    viewportTileIds: new Set(),
    loadingTileIds: new Set(),
    loadedTileIds: new Set(),
    pointCountByTileId: new Map(),
  };

  const publish = () => {
    setProgress(derivePointsTileLoadProgress(tracker));
  };

  return {
    onViewportTilesRequested: (tiles) => {
      tracker.viewportTileIds = new Set(tiles.map((tile) => tile.tileId));
      publish();
    },
    onTileLoadStart: (tile) => {
      tracker.loadingTileIds.add(tile.tileId);
      tracker.loadedTileIds.delete(tile.tileId);
      tracker.pointCountByTileId.delete(tile.tileId);
      publish();
    },
    onTileLoadEnd: (tile, result) => {
      tracker.loadingTileIds.delete(tile.tileId);
      const success = result.success && !result.aborted;
      if (success) {
        tracker.loadedTileIds.add(tile.tileId);
        tracker.pointCountByTileId.set(tile.tileId, result.pointCount ?? 0);
      } else {
        tracker.loadedTileIds.delete(tile.tileId);
        tracker.pointCountByTileId.delete(tile.tileId);
      }
      publish();
    },
  };
}
