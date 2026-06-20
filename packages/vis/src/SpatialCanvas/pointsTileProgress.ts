import type { PointsTileHandle, PointsTileLoadResult } from '@spatialdata/layers';

export interface PointsTileLoadProgress {
  /** Tiles currently fetching data. */
  inFlight: number;
  /** Tiles finished in the current viewport batch. */
  loaded: number;
  /** Tiles deck.gl requested for the current viewport. */
  viewportTotal: number;
}

export type { PointsTileHandle, PointsTileLoadResult };

export interface PointsTileLoadCallbacks {
  onViewportTilesRequested?: (tiles: readonly PointsTileHandle[]) => void;
  onTileLoadStart?: (tile: PointsTileHandle) => void;
  onTileLoadEnd?: (tile: PointsTileHandle, result: PointsTileLoadResult) => void;
}

export function emptyPointsTileLoadProgress(): PointsTileLoadProgress {
  return { inFlight: 0, loaded: 0, viewportTotal: 0 };
}

export function aggregatePointsTileLoadProgress(
  progressByLayer: ReadonlyMap<string, PointsTileLoadProgress>
): PointsTileLoadProgress {
  let inFlight = 0;
  let loaded = 0;
  let viewportTotal = 0;
  for (const progress of progressByLayer.values()) {
    inFlight += progress.inFlight;
    loaded += progress.loaded;
    viewportTotal += progress.viewportTotal;
  }
  return { inFlight, loaded, viewportTotal };
}

export function pointsTileLoadingMessage(progress: PointsTileLoadProgress): string | null {
  const { inFlight, loaded, viewportTotal } = progress;
  const awaitingViewport =
    viewportTotal > 0 && loaded < viewportTotal && inFlight === 0;
  if (inFlight <= 0 && !awaitingViewport) {
    return null;
  }
  if (viewportTotal > 0) {
    return `Loading points… (${loaded}/${viewportTotal} tiles)`;
  }
  return inFlight > 0 ? 'Loading points…' : null;
}

export function isPointsTileLoading(progress: PointsTileLoadProgress): boolean {
  return pointsTileLoadingMessage(progress) !== null;
}

export function createPointsTileLoadCallbacks(
  getProgress: () => PointsTileLoadProgress,
  setProgress: (progress: PointsTileLoadProgress) => void
): PointsTileLoadCallbacks {
  return {
    onViewportTilesRequested: (tiles) => {
      setProgress({ inFlight: 0, loaded: 0, viewportTotal: tiles.length });
    },
    onTileLoadStart: () => {
      const current = getProgress();
      setProgress({ ...current, inFlight: current.inFlight + 1 });
    },
    onTileLoadEnd: (tile, result) => {
      void tile;
      const current = getProgress();
      const success = result.success && !result.aborted;
      setProgress({
        ...current,
        inFlight: Math.max(0, current.inFlight - 1),
        loaded: success ? current.loaded + 1 : current.loaded,
      });
    },
  };
}
