import type { SpatialBounds } from '@spatialdata/core';
import type { PointsTileHandle, PointsTileLoadResult } from './pointsTileLoadCallbacks.js';

export type PointsTileStatus =
  | 'pending'
  | 'loading'
  | 'loaded'
  | 'empty'
  | 'error'
  | 'aborted';

export interface PointsTileLoadProgress {
  inFlight: number;
  loaded: number;
  viewportTotal: number;
}

export interface PointsTileDebugEntry {
  tileId: string;
  index: { x: number; y: number; z: number };
  bbox: SpatialBounds;
  clippedBounds: SpatialBounds | null;
  status: PointsTileStatus;
  requestedAt: number;
  startedAt?: number;
  completedAt?: number;
  pointCount?: number;
  loadMode?: string;
  errorMessage?: string;
}

export const POINTS_TILE_DEBUG_PICK_KIND = 'spatialdata-points-tile-debug' as const;

export interface PointsTileDebugPickObject {
  kind: typeof POINTS_TILE_DEBUG_PICK_KIND;
  entry: PointsTileDebugEntry;
}

export function isPointsTileDebugPickObject(
  value: unknown
): value is PointsTileDebugPickObject {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const candidate = value as Partial<PointsTileDebugPickObject>;
  return candidate.kind === POINTS_TILE_DEBUG_PICK_KIND && candidate.entry != null;
}

export type PointsTileDebugEvent =
  | { type: 'viewport'; tiles: readonly PointsTileHandle[]; at: number }
  | { type: 'start'; tile: PointsTileHandle; at: number }
  | {
      type: 'end';
      tile: PointsTileHandle;
      result: PointsTileLoadResult;
      at: number;
      clipBounds: SpatialBounds;
    };

export function reduceTileDebugEntries(
  previous: readonly PointsTileDebugEntry[],
  event: PointsTileDebugEvent
): PointsTileDebugEntry[] {
  const byId = new Map(previous.map((entry) => [entry.tileId, entry]));

  if (event.type === 'viewport') {
    const next = new Map<string, PointsTileDebugEntry>();
    for (const tile of event.tiles) {
      const rawBounds = boundsFromHandle(tile);
      const existing = byId.get(tile.tileId);
      next.set(tile.tileId, {
        tileId: tile.tileId,
        index: tile.index,
        bbox: rawBounds,
        clippedBounds: existing?.clippedBounds ?? null,
        status:
          existing?.status === 'loaded' || existing?.status === 'empty'
            ? existing.status
            : 'pending',
        requestedAt: event.at,
        startedAt: existing?.startedAt,
        completedAt: existing?.completedAt,
        pointCount: existing?.pointCount,
        loadMode: existing?.loadMode,
        errorMessage: existing?.errorMessage,
      });
    }
    return [...next.values()];
  }

  if (event.type === 'start') {
    const rawBounds = boundsFromHandle(event.tile);
    const existing = byId.get(event.tile.tileId);
    byId.set(event.tile.tileId, {
      tileId: event.tile.tileId,
      index: event.tile.index,
      bbox: rawBounds,
      clippedBounds: existing?.clippedBounds ?? null,
      status: 'loading',
      requestedAt: existing?.requestedAt ?? event.at,
      startedAt: event.at,
      completedAt: undefined,
      pointCount: undefined,
      loadMode: undefined,
      errorMessage: undefined,
    });
    return [...byId.values()];
  }

  const rawBounds = boundsFromHandle(event.tile);
  const { result } = event;
  let status: PointsTileStatus = 'error';
  if (result.aborted) {
    status = 'aborted';
  } else if (result.success) {
    status = (result.pointCount ?? 0) > 0 ? 'loaded' : 'empty';
  }

  byId.set(event.tile.tileId, {
    tileId: event.tile.tileId,
    index: event.tile.index,
    bbox: rawBounds,
    clippedBounds: result.clippedBounds ?? event.clipBounds,
    status,
    requestedAt: byId.get(event.tile.tileId)?.requestedAt ?? event.at,
    startedAt: byId.get(event.tile.tileId)?.startedAt ?? event.at,
    completedAt: event.at,
    pointCount: result.pointCount,
    loadMode: result.loadMode,
    errorMessage: result.errorMessage,
  });
  return [...byId.values()];
}

function boundsFromHandle(tile: PointsTileHandle): SpatialBounds {
  const { bbox } = tile;
  return {
    minX: Math.min(bbox.left, bbox.right),
    maxX: Math.max(bbox.left, bbox.right),
    minY: Math.min(bbox.top, bbox.bottom),
    maxY: Math.max(bbox.top, bbox.bottom),
  };
}

export interface PointsTileDebugPolygonDatum {
  polygon: [number, number][];
  entry: PointsTileDebugEntry;
}

export function pointsTileDebugPolygonData(
  entries: readonly PointsTileDebugEntry[]
): PointsTileDebugPolygonDatum[] {
  return entries.map((entry) => {
    const bounds = entry.clippedBounds ?? entry.bbox;
    const { minX, minY, maxX, maxY } = bounds;
    return {
      entry,
      polygon: [
        [minX, minY],
        [maxX, minY],
        [maxX, maxY],
        [minX, maxY],
      ],
    };
  });
}

function formatBounds(bounds: SpatialBounds): string {
  return `[${bounds.minX.toFixed(1)}, ${bounds.minY.toFixed(1)}]–[${bounds.maxX.toFixed(1)}, ${bounds.maxY.toFixed(1)}]`;
}

function formatDuration(ms: number): string {
  if (ms < 1000) {
    return `${Math.round(ms)}ms`;
  }
  return `${(ms / 1000).toFixed(2)}s`;
}

export function formatPointsTileDebugTooltip(
  entry: PointsTileDebugEntry,
  batchProgress: PointsTileLoadProgress,
  now = Date.now()
): { title: string; items: Array<{ label: string; value: string }> } {
  const items: Array<{ label: string; value: string }> = [
    { label: 'tile', value: entry.tileId },
    { label: 'status', value: entry.status },
    {
      label: 'batch',
      value: `${batchProgress.loaded}/${batchProgress.viewportTotal} (${batchProgress.inFlight} in flight)`,
    },
    { label: 'index', value: `x=${entry.index.x} y=${entry.index.y} z=${entry.index.z}` },
    { label: 'bbox', value: formatBounds(entry.bbox) },
  ];

  if (entry.clippedBounds) {
    items.push({ label: 'clipped', value: formatBounds(entry.clippedBounds) });
  }
  if (entry.startedAt !== undefined) {
    if (entry.completedAt !== undefined) {
      items.push({
        label: 'duration',
        value: formatDuration(entry.completedAt - entry.startedAt),
      });
    } else {
      items.push({
        label: 'elapsed',
        value: formatDuration(now - entry.startedAt),
      });
    }
  }
  if (entry.pointCount !== undefined) {
    items.push({ label: 'points', value: String(entry.pointCount) });
  }
  if (entry.loadMode) {
    items.push({ label: 'load mode', value: entry.loadMode });
  }
  if (entry.errorMessage) {
    items.push({ label: 'error', value: entry.errorMessage });
  }

  return {
    title: `Tile ${entry.tileId}`,
    items,
  };
}

export function tileDebugStatusFillColor(
  status: PointsTileStatus
): [number, number, number, number] {
  switch (status) {
    case 'pending':
      return [120, 120, 120, 30];
    case 'loading':
      return [255, 180, 0, 80];
    case 'loaded':
      return [80, 200, 80, 25];
    case 'empty':
      return [120, 160, 200, 35];
    case 'error':
      return [220, 60, 60, 70];
    case 'aborted':
      return [180, 80, 80, 45];
  }
}

export function tileDebugStatusLineColor(
  status: PointsTileStatus
): [number, number, number, number] {
  switch (status) {
    case 'pending':
      return [180, 180, 180, 180];
    case 'loading':
      return [255, 200, 0, 255];
    case 'loaded':
      return [80, 220, 80, 220];
    case 'empty':
      return [140, 180, 220, 220];
    case 'error':
      return [255, 80, 80, 255];
    case 'aborted':
      return [220, 120, 120, 220];
  }
}

export function tileDebugEntriesSignature(entries: readonly PointsTileDebugEntry[]): string {
  return entries
    .map((entry) => `${entry.tileId}:${entry.status}:${entry.pointCount ?? ''}`)
    .join('|');
}
