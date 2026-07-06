import type { Matrix4 } from '@math.gl/core';
import { COORDINATE_SYSTEM } from '@deck.gl/core';
import { ScatterplotLayer } from 'deck.gl';
import type { ColumnarNdarrayPointsBatch } from './pointsLoader.js';
import { pointDataFromColumnarBatch } from './pointsLoader.js';

/** Orthographic zoom at which configured pointSize applies at full scale. */
export const POINT_SIZE_ZOOM_REFERENCE = 0;
/** Minimum radius multiplier when zoomed out (reduces fragment overdraw). */
export const MIN_POINT_SIZE_SCALE = 0.15;
export const DEFAULT_POINT_SIZE = 0.1;
export const DEFAULT_POINT_RADIUS_MIN_PIXELS = 0.1;
export const DEFAULT_POINT_RADIUS_MAX_PIXELS = 3;

export function zoomScaledPointSize(
  pointSize: number,
  zoom: number | null | undefined,
  zoomReference = POINT_SIZE_ZOOM_REFERENCE,
  minScale = MIN_POINT_SIZE_SCALE
): number {
  if (zoom === null || zoom === undefined || !Number.isFinite(zoom)) {
    return pointSize;
  }
  const scale = 2 ** (zoom - zoomReference);
  return pointSize * Math.min(1, Math.max(minScale, scale));
}

export interface PointsScatterStyleProps {
  color: [number, number, number, number];
  pointSize: number;
  pointRadiusMinPixels?: number;
  pointRadiusMaxPixels?: number;
  pointMinSizeScale?: number;
  viewZoom?: number | null;
  opacity: number;
  modelMatrix: Matrix4;
  use3d?: boolean;
  tileBounds?: [number, number, number, number];
  tileSubLayer?: boolean;
}

export function renderColumnarScatterLayer(
  id: string,
  batch: ColumnarNdarrayPointsBatch,
  props: PointsScatterStyleProps
) {
  const pointData = pointDataFromColumnarBatch(batch);
  const d = pointData.data;

  // Preloaded scatter sizes points in WORLD (common) units so the GPU scales
  // them with zoom — points shrink when you zoom out, which is exactly where
  // scatter overdraw is worst — while `radiusMinPixels`/`radiusMaxPixels` clamp
  // the projected radius so points never vanish or bloat. The Morton tile path
  // keeps fixed pixel sizing (tiles are already viewport-bounded).
  const isTile = props.tileSubLayer === true;
  const radiusUnits: 'common' | 'pixels' = isTile ? 'pixels' : 'common';
  const radiusMinPixels = props.pointRadiusMinPixels ?? DEFAULT_POINT_RADIUS_MIN_PIXELS;
  const radiusMaxPixels = props.pointRadiusMaxPixels ?? DEFAULT_POINT_RADIUS_MAX_PIXELS;

  const pointCount = batch.pointCount ?? batch.shape[1] ?? d[0]?.length ?? 0;

  return new ScatterplotLayer({
    id,
    coordinateSystem: COORDINATE_SYSTEM.CARTESIAN,
    data: d[0],
    ...(props.tileBounds ? { bounds: props.tileBounds } : {}),
    getPosition: (_d, { index, target }) => [
      d[0][index],
      d[1][index],
      props.use3d ? d[2]?.[index] || 0 : 0,
    ],
    getRadius: props.pointSize,
    radiusUnits,
    radiusMinPixels,
    radiusMaxPixels,
    getFillColor: props.color,
    opacity: props.opacity,
    modelMatrix: props.modelMatrix,
    pickable: true,
    autoHighlight: true,
    highlightColor: [255, 255, 0, 200],
    updateTriggers: {
      getPosition: [pointCount, d[0], d[1], d[2]],
      getRadius: [props.pointSize],
    },
  });
}
