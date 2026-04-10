/**
 * Fit orthographic view state to axis-aligned bounds in world coordinates.
 * Zoom matches @vivjs/views getDefaultInitialViewState (log2 scale, optional backoff).
 */

import { getDefaultInitialViewState, getImageSize } from '@hms-dbmi/viv';
import { Matrix4 } from '@math.gl/core';
import type { PointData } from './renderers/pointsRenderer';
import type { ViewState2D } from './types';

export type AxisAlignedBounds = {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
};

/** Same default as ImageView / Viv detail framing. */
export const DEFAULT_ZOOM_BACK_OFF = 0.2;

function getPhysicalSizeScalingMatrix(loader: {
  meta?: { physicalSizes?: Record<string, { size?: number } | undefined> };
}): Matrix4 {
  const { x, y, z } = loader?.meta?.physicalSizes ?? {};
  if (x?.size !== undefined && y?.size !== undefined && z?.size !== undefined) {
    const min = Math.min(z.size, x.size, y.size);
    const ratio: [number, number, number] = [x.size / min, y.size / min, z.size / min];
    return new Matrix4().scale(ratio);
  }
  return new Matrix4();
}

export function unionBounds(a: AxisAlignedBounds, b: AxisAlignedBounds): AxisAlignedBounds {
  return {
    minX: Math.min(a.minX, b.minX),
    minY: Math.min(a.minY, b.minY),
    maxX: Math.max(a.maxX, b.maxX),
    maxY: Math.max(a.maxY, b.maxY),
  };
}

export function unionBoundsList(bounds: AxisAlignedBounds[]): AxisAlignedBounds | null {
  if (bounds.length === 0) return null;
  return bounds.reduce((acc, cur) => unionBounds(acc, cur));
}

/**
 * Viv-compatible zoom for fitting a world-space axis-aligned rectangle into the viewport.
 */
export function viewStateFromBounds(
  bounds: AxisAlignedBounds,
  viewWidth: number,
  viewHeight: number,
  zoomBackOff: number = DEFAULT_ZOOM_BACK_OFF
): ViewState2D {
  const cx = (bounds.minX + bounds.maxX) / 2;
  const cy = (bounds.minY + bounds.maxY) / 2;
  let trueWidth = bounds.maxX - bounds.minX;
  let trueHeight = bounds.maxY - bounds.minY;
  const eps = 1e-9;
  if (trueWidth < eps) trueWidth = eps;
  if (trueHeight < eps) trueHeight = eps;
  const zoom = Math.log2(Math.min(viewWidth / trueWidth, viewHeight / trueHeight)) - zoomBackOff;
  return { target: [cx, cy], zoom };
}

function xyPairFromVertex(v: unknown): [number, number] | null {
  if (!Array.isArray(v) || v.length < 2) return null;
  const x = v[0];
  const y = v[1];
  if (typeof x !== 'number' || typeof y !== 'number') return null;
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  return [x, y];
}

/**
 * Walk nested polygon / multipolygon coordinate trees from loaders (WKB / GeoJSON-style).
 * Skips malformed vertices instead of throwing.
 */
function accumulatePolygonBounds(
  polygons: unknown,
  modelMatrix: Matrix4,
  depth = 0
): AxisAlignedBounds | null {
  if (depth > 12) return null;
  if (!Array.isArray(polygons) || polygons.length === 0) return null;

  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  let any = false;

  const addXY = (x: number, y: number) => {
    try {
      const p = modelMatrix.transformPoint([x, y, 0]);
      if (!Number.isFinite(p[0]) || !Number.isFinite(p[1])) return;
      any = true;
      minX = Math.min(minX, p[0]);
      maxX = Math.max(maxX, p[0]);
      minY = Math.min(minY, p[1]);
      maxY = Math.max(maxY, p[1]);
    } catch {
      // ignore bad transform
    }
  };

  const head = polygons[0];
  const headPair = xyPairFromVertex(head);

  if (headPair !== null && polygons.every((v) => xyPairFromVertex(v) !== null)) {
    for (const v of polygons) {
      const pair = xyPairFromVertex(v);
      if (pair) addXY(pair[0], pair[1]);
    }
    return any ? { minX, minY, maxX, maxY } : null;
  }

  for (const item of polygons) {
    if (item === null || item === undefined) continue;
    const nested = accumulatePolygonBounds(item, modelMatrix, depth + 1);
    if (!nested) continue;
    any = true;
    minX = Math.min(minX, nested.minX);
    minY = Math.min(minY, nested.minY);
    maxX = Math.max(maxX, nested.maxX);
    maxY = Math.max(maxY, nested.maxY);
  }

  return any ? { minX, minY, maxX, maxY } : null;
}

export function boundsFromPolygons(
  polygons: unknown,
  modelMatrix: Matrix4
): AxisAlignedBounds | null {
  return accumulatePolygonBounds(polygons, modelMatrix, 0);
}

export function boundsFromPoints(
  pointData: PointData,
  modelMatrix: Matrix4,
  use3d = false
): AxisAlignedBounds | null {
  const d = pointData.data;
  const n = d[0]?.length ?? 0;
  if (n === 0) return null;
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  let any = false;
  for (let i = 0; i < n; i++) {
    const x = d[0][i];
    const y = d[1][i];
    const z = use3d ? (d[2]?.[i] ?? 0) : 0;
    if (
      typeof x !== 'number' ||
      typeof y !== 'number' ||
      !Number.isFinite(x) ||
      !Number.isFinite(y)
    ) {
      continue;
    }
    try {
      const p = modelMatrix.transformPoint([x, y, z]);
      if (!Number.isFinite(p[0]) || !Number.isFinite(p[1])) continue;
      any = true;
      minX = Math.min(minX, p[0]);
      maxX = Math.max(maxX, p[0]);
      minY = Math.min(minY, p[1]);
      maxY = Math.max(maxY, p[1]);
    } catch {
      // skip
    }
  }
  return any ? { minX, minY, maxX, maxY } : null;
}

export function boundsFromImageLoader(
  loader: unknown,
  modelMatrix: Matrix4
): AxisAlignedBounds | null {
  try {
    const source = Array.isArray(loader) ? loader[0] : loader;
    if (!source || typeof source !== 'object') return null;
    // PixelSource typing is strict; loader at runtime matches Viv loaders.
    const { width: pixelWidth, height: pixelHeight } = getImageSize(source as never);
    const physical = getPhysicalSizeScalingMatrix(
      source as { meta?: { physicalSizes?: Record<string, { size?: number }> } }
    );
    let minX = Number.POSITIVE_INFINITY;
    let minY = Number.POSITIVE_INFINITY;
    let maxX = Number.NEGATIVE_INFINITY;
    let maxY = Number.NEGATIVE_INFINITY;
    const corners: [number, number, number][] = [
      [0, 0, 0],
      [pixelWidth, 0, 0],
      [pixelWidth, pixelHeight, 0],
      [0, pixelHeight, 0],
    ];
    for (const c of corners) {
      const p = modelMatrix.transformPoint(physical.transformPoint(c));
      minX = Math.min(minX, p[0]);
      maxX = Math.max(maxX, p[0]);
      minY = Math.min(minY, p[1]);
      maxY = Math.max(maxY, p[1]);
    }
    return { minX, minY, maxX, maxY };
  } catch {
    return null;
  }
}

/**
 * View state that matches Viv's getDefaultInitialViewState for a single image layer
 * (including modelMatrix and physical size scaling).
 */
type VivInitialViewState = { target: [number, number, number]; zoom: number | number[] };

/** Viv .d.ts wrongly types modelMatrix as boolean; runtime uses Matrix4. */
const getDefaultInitialViewStateWithMatrix = getDefaultInitialViewState as unknown as (
  loader: object,
  viewSize: { width: number; height: number },
  zoomBackOff?: number,
  use3d?: boolean,
  modelMatrix?: Matrix4
) => VivInitialViewState;

export function viewStateForImageLayer(
  loader: unknown,
  viewWidth: number,
  viewHeight: number,
  modelMatrix: Matrix4,
  zoomBackOff: number = DEFAULT_ZOOM_BACK_OFF
): ViewState2D {
  const vs = getDefaultInitialViewStateWithMatrix(
    loader as object,
    { width: viewWidth, height: viewHeight },
    zoomBackOff,
    false,
    modelMatrix
  );
  const target = vs.target;
  const zoomRaw = vs.zoom;
  const zoom = Array.isArray(zoomRaw) ? (zoomRaw[0] ?? 0) : (zoomRaw ?? 0);
  return { target: [target[0], target[1]], zoom };
}
