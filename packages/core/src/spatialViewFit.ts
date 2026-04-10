/**
 * Orthographic 2D view fitting and world-space bounds for spatial data.
 * Framework-agnostic: no React, deck.gl, or Viv. Used by @spatialdata/vis and other hosts.
 */

import { Matrix4 } from '@math.gl/core';

/** Axis-aligned rectangle in world / target coordinate space. */
export type AxisAlignedBounds = {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
};

/** Pan/zoom state compatible with Viv / deck OrthographicView detail views. */
export type OrthographicViewState2D = {
  target: [number, number];
  zoom: number;
};

/** Ndarray-style columnar points: data[0]=x, data[1]=y, optional data[2]=z. */
export type PointsColumnarData = {
  data: number[][];
  shape?: number[];
};

/** Same default as Viv ImageView detail framing. */
export const DEFAULT_ZOOM_BACK_OFF = 0.2;

/** OME-style physical size ratios on a loader-like `meta` object. */
export type PhysicalSizesMeta = {
  meta?: { physicalSizes?: Record<string, { size?: number } | undefined> };
};

export function getPhysicalSizeScalingMatrixFromMeta(loaderLike: PhysicalSizesMeta): Matrix4 {
  const { x, y, z } = loaderLike?.meta?.physicalSizes ?? {};
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
): OrthographicViewState2D {
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
  pointData: PointsColumnarData,
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

/**
 * World-space bounds of an image raster in pixel coordinates [0..w]×[0..h],
 * after optional OME physical-size scaling and modelMatrix (e.g. transform to a coordinate system).
 */
export function boundsFromImagePixelExtents(
  pixelWidth: number,
  pixelHeight: number,
  modelMatrix: Matrix4,
  physicalSizeScalingMatrix: Matrix4 = new Matrix4()
): AxisAlignedBounds | null {
  if (
    !Number.isFinite(pixelWidth) ||
    !Number.isFinite(pixelHeight) ||
    pixelWidth <= 0 ||
    pixelHeight <= 0
  ) {
    return null;
  }
  try {
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
      const p = modelMatrix.transformPoint(physicalSizeScalingMatrix.transformPoint(c));
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
 * Initial orthographic view for a raster image — same math as @vivjs/views `getDefaultInitialViewState`
 * (2D path). Callers supply pixel size (e.g. from Viv `getImageSize`) and optional physical scaling from
 * {@link getPhysicalSizeScalingMatrixFromMeta}.
 */
export function viewStateForOrthographicImageFit(params: {
  pixelWidth: number;
  pixelHeight: number;
  viewWidth: number;
  viewHeight: number;
  modelMatrix: Matrix4;
  zoomBackOff?: number;
  use3d?: boolean;
  /** Pixel extent along z (Viv uses shape[labels.indexOf('z')]); used when use3d is true. */
  zAxisPixelSize?: number;
  physicalSizeScalingMatrix?: Matrix4;
}): OrthographicViewState2D {
  const {
    pixelWidth,
    pixelHeight,
    viewWidth,
    viewHeight,
    modelMatrix,
    zoomBackOff = DEFAULT_ZOOM_BACK_OFF,
    use3d = false,
    zAxisPixelSize = 0,
    physicalSizeScalingMatrix = new Matrix4(),
  } = params;

  const scale = modelMatrix.getScale();
  const trueWidth = scale[0] * pixelWidth;
  const trueHeight = scale[1] * pixelHeight;
  const zoom = Math.log2(Math.min(viewWidth / trueWidth, viewHeight / trueHeight)) - zoomBackOff;

  const inner = use3d ? physicalSizeScalingMatrix : new Matrix4();
  const zMid = use3d && zAxisPixelSize > 0 ? zAxisPixelSize / 2 : 0;
  const target3 = modelMatrix.transformPoint(
    inner.transformPoint([pixelWidth / 2, pixelHeight / 2, zMid])
  );

  return {
    target: [target3[0], target3[1]],
    zoom,
  };
}
