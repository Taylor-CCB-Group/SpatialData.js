import type {
  PointsTileLoadProgress,
  TileDebugStore,
  TiledPointsDebugState,
} from '@spatialdata/layers';

export type { PointsTileLoadProgress };

export function emptyPointsTileLoadProgress(): PointsTileLoadProgress {
  return { inFlight: 0, loaded: 0, loadedPoints: 0, viewportTotal: 0 };
}

export function pointsTileLoadProgressFromDebugState(
  state: TiledPointsDebugState | undefined
): PointsTileLoadProgress {
  if (!state) {
    return emptyPointsTileLoadProgress();
  }

  const viewportTileIds = new Set((state.lastViewportTiles ?? []).map((tile) => tile.tileId));
  const loadingTileIds = new Set(state.loadingTileIds ?? []);
  const completedTilesById = state.completedTilesById ?? {};

  let inFlight = 0;
  let loaded = 0;
  let loadedPoints = 0;
  for (const tileId of viewportTileIds) {
    if (loadingTileIds.has(tileId)) {
      inFlight += 1;
    }
    const completed = completedTilesById[tileId];
    if (completed?.status === 'loaded' || completed?.status === 'empty') {
      loaded += 1;
      loadedPoints += completed.pointCount ?? 0;
    }
  }

  return {
    inFlight,
    loaded,
    loadedPoints,
    viewportTotal: viewportTileIds.size,
  };
}

export function pointsTileLoadProgressFromStore(
  store: TileDebugStore | undefined
): PointsTileLoadProgress {
  return pointsTileLoadProgressFromDebugState(store?.getState());
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
  if (inFlight <= 0) {
    return null;
  }
  const pointsSuffix = loaded > 0 ? `, ${formatLoadedPointCount(loadedPoints)} points` : '';
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
