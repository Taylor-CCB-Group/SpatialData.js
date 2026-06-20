import type { SpatialBounds } from '@spatialdata/core';
import type { PointTileBbox } from './pointsBbox.js';

export interface PointsTileHandle {
  tileId: string;
  index: { x: number; y: number; z: number };
  bbox: PointTileBbox;
}

export interface PointsTileLoadResult {
  success: boolean;
  aborted?: boolean;
  clippedBounds?: SpatialBounds | null;
  pointCount?: number;
  loadMode?: string;
  errorMessage?: string;
}

export interface PointsTileLoadCallbacks {
  onViewportTilesRequested?: (tiles: readonly PointsTileHandle[]) => void;
  onTileLoadStart?: (tile: PointsTileHandle) => void;
  onTileLoadEnd?: (tile: PointsTileHandle, result: PointsTileLoadResult) => void;
}
