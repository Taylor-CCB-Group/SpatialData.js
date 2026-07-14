import type { SpatialBounds } from '@spatialdata/core';
import type { PointsTileHandle } from './pointsTileLoadCallbacks.js';

export type PointTileBbox = {
  left: number;
  right: number;
  top: number;
  bottom: number;
};

export function isPointTileBbox(value: unknown): value is PointTileBbox {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.left === 'number' &&
    typeof candidate.right === 'number' &&
    typeof candidate.top === 'number' &&
    typeof candidate.bottom === 'number'
  );
}

export function intersectBounds(query: SpatialBounds, clip: SpatialBounds): SpatialBounds | null {
  const minX = Math.max(query.minX, clip.minX);
  const maxX = Math.min(query.maxX, clip.maxX);
  const minY = Math.max(query.minY, clip.minY);
  const maxY = Math.min(query.maxY, clip.maxY);
  if (minX > maxX || minY > maxY) {
    return null;
  }
  return { minX, minY, maxX, maxY };
}

export function boundsFromTileBbox(bbox: PointTileBbox): SpatialBounds {
  return {
    minX: Math.min(bbox.left, bbox.right),
    maxX: Math.max(bbox.left, bbox.right),
    minY: Math.min(bbox.top, bbox.bottom),
    maxY: Math.max(bbox.top, bbox.bottom),
  };
}

export function scatterBoundsFromTileBbox(bbox: PointTileBbox): [number, number, number, number] {
  return [bbox.left, bbox.top, bbox.right, bbox.bottom];
}

export function tileHandleFromDeckTile(tile: {
  index?: { x: number; y: number; z: number };
  id?: string;
  bbox?: unknown;
}): PointsTileHandle | null {
  if (!tile.index || !isPointTileBbox(tile.bbox)) {
    return null;
  }
  const { x, y, z } = tile.index;
  return {
    tileId: tile.id ?? `${x}-${y}-${z}`,
    index: { x, y, z },
    bbox: tile.bbox,
  };
}
