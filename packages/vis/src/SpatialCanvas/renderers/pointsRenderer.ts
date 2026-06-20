/**
 * Points layer renderer using deck.gl ScatterplotLayer
 *
 * Renders point cloud data from SpatialData points elements.
 */

import type { Matrix4 } from '@math.gl/core';
import type { PointsElement, PointsTilingMetadata, SpatialBounds } from '@spatialdata/core';
import { COORDINATE_SYSTEM } from '@deck.gl/core';
import { ScatterplotLayer, TileLayer } from 'deck.gl';
import type { Layer } from 'deck.gl';
import type { PointsTileLoadCallbacks } from '../pointsTileProgress';

export interface PointDataX {
  position: [number, number] | [number, number, number];
  // Additional properties can be added for coloring, sizing, etc.
  [key: string]: unknown;
}

// this is ndarray and should be defined elsewhere
// not that we wouldn't also want to be able to have other data & accessors
export interface PointData {
  shape: number[];
  // this should most definitely be TypedArray...
  data: ArrayLike<number>[];
}

/** Orthographic zoom at which configured pointSize applies at full scale. */
export const POINT_SIZE_ZOOM_REFERENCE = 0;
/** Minimum radius multiplier when zoomed out (reduces fragment overdraw). */
export const MIN_POINT_SIZE_SCALE = 0.15;
export const DEFAULT_POINT_SIZE = 1;
export const DEFAULT_POINT_RADIUS_MIN_PIXELS = 1;
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

export interface PointsLayerRenderConfig {
  /** The points element to render */
  element: PointsElement;
  /** Unique layer ID */
  id: string;
  /** Transformation matrix to target coordinate system */
  modelMatrix: Matrix4;
  /** Layer opacity (0-1) */
  opacity: number;
  /** Whether layer is visible */
  visible: boolean;
  /** Point radius in pixels */
  pointSize?: number;
  pointRadiusMinPixels?: number;
  pointRadiusMaxPixels?: number;
  pointMinSizeScale?: number;
  /** Orthographic view zoom used to scale pointSize when zoomed out */
  viewZoom?: number | null;
  /** Point color [r, g, b, a] (0-255) */
  color?: [number, number, number, number];
  /** Integer codes matching `{feature_key}_codes` in the Morton Parquet artifact. */
  featureCodes?: readonly number[];
  /** ndarray - if we want other data for properties like color/radius etc they will be handled differently */
  pointData?: PointData;
  pointTilingMetadata?: PointsTilingMetadata;
  tileLoadCallbacks?: PointsTileLoadCallbacks;
  use3d?: boolean;
}

type PointTileBbox = {
  left: number;
  right: number;
  top: number;
  bottom: number;
};

type PointTileLoadProps = {
  bbox: unknown;
  signal?: AbortSignal;
};

function isAbortError(error: unknown) {
  return error instanceof DOMException && error.name === 'AbortError';
}

function isPointTileBbox(value: unknown): value is PointTileBbox {
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

export function intersectBounds(
  query: SpatialBounds,
  clip: SpatialBounds
): SpatialBounds | null {
  const minX = Math.max(query.minX, clip.minX);
  const maxX = Math.min(query.maxX, clip.maxX);
  const minY = Math.max(query.minY, clip.minY);
  const maxY = Math.min(query.maxY, clip.maxY);
  if (minX > maxX || minY > maxY) {
    return null;
  }
  return { minX, minY, maxX, maxY };
}

function scatterBoundsFromTileBbox(bbox: PointTileBbox): [number, number, number, number] {
  return [bbox.left, bbox.top, bbox.right, bbox.bottom];
}

function boundsFromTileBbox(bbox: PointTileBbox): SpatialBounds {
  return {
    minX: Math.min(bbox.left, bbox.right),
    maxX: Math.max(bbox.left, bbox.right),
    minY: Math.min(bbox.top, bbox.bottom),
    maxY: Math.max(bbox.top, bbox.bottom),
  };
}

function renderPointScatterSubLayer(
  id: string,
  data: PointData,
  props: {
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
    /** Tile sublayers use fixed pixel radius (Vitessce pattern). */
    tileSubLayer?: boolean;
  }
) {
  const d = data.data;
  const effectivePointSize = props.tileSubLayer
    ? props.pointSize
    : zoomScaledPointSize(
        props.pointSize,
        props.viewZoom,
        POINT_SIZE_ZOOM_REFERENCE,
        props.pointMinSizeScale ?? MIN_POINT_SIZE_SCALE
      );
  return new ScatterplotLayer({
    id,
    data: d[0],
    ...(props.tileBounds ? { bounds: props.tileBounds } : {}),
    getPosition: (_d, { index, target }) => [
      d[0][index],
      d[1][index],
      props.use3d ? d[2]?.[index] || 0 : 0,
    ],
    getRadius: effectivePointSize,
    ...(props.tileSubLayer
      ? {
          radiusMinPixels: props.pointRadiusMinPixels ?? DEFAULT_POINT_RADIUS_MIN_PIXELS,
          radiusMaxPixels: props.pointRadiusMaxPixels ?? DEFAULT_POINT_RADIUS_MAX_PIXELS,
        }
      : {}),
    radiusUnits: 'pixels',
    getFillColor: props.color,
    opacity: props.opacity,
    modelMatrix: props.modelMatrix,
    pickable: true,
    autoHighlight: true,
    highlightColor: [255, 255, 0, 200],
    updateTriggers: {
      getRadius: [
        props.pointSize,
        props.viewZoom,
        props.pointRadiusMinPixels,
        props.pointRadiusMaxPixels,
        props.pointMinSizeScale,
      ],
    },
  });
}

/**
 * Create a deck.gl ScatterplotLayer for points data.
 *
 * Note: This requires the point data to be pre-loaded since deck.gl layers
 * are synchronous. The data loading should happen at a higher level.
 */
export function renderPointsLayer(config: PointsLayerRenderConfig): Layer | null {
  const {
    element,
    id,
    modelMatrix,
    opacity,
    visible,
    pointSize = DEFAULT_POINT_SIZE,
    pointRadiusMinPixels,
    pointRadiusMaxPixels,
    pointMinSizeScale,
    viewZoom,
    color = [255, 100, 100, 200],
    pointData,
    pointTilingMetadata,
    featureCodes,
    tileLoadCallbacks,
    use3d,
  } = config;

  if (!visible) return null;

  const scatterStyleProps = {
    color,
    pointSize,
    pointRadiusMinPixels,
    pointRadiusMaxPixels,
    pointMinSizeScale,
    viewZoom,
    opacity,
    modelMatrix,
    use3d,
  };

  if (!pointData) {
    if (!pointTilingMetadata?.bounds) {
      console.debug(
        `[PointsRenderer] No point data for layer "${id}" from ${element.url ?? element.path}`
      );
      return null;
    }
    const localBounds = pointTilingMetadata.bounds;
    return new TileLayer({
      id,
      coordinateSystem: COORDINATE_SYSTEM.CARTESIAN,
      modelMatrix,
      extent: [
        localBounds.minX,
        localBounds.minY,
        localBounds.maxX,
        localBounds.maxY,
      ],
      opacity,
      visible,
      tileSize: 512,
      // Vitessce: single tile resolution. extent enables z=-1 clamp when viewZoom < -1.
      minZoom: -1,
      maxZoom: -1,
      refinementStrategy: 'best-available',
      updateTriggers: {
        getTileData: [pointTilingMetadata.parquetPath, featureCodes],
        renderSubLayers: [
          pointSize,
          pointRadiusMinPixels,
          pointRadiusMaxPixels,
          pointMinSizeScale,
          viewZoom,
          color,
          opacity,
          modelMatrix,
          use3d,
        ],
      },
      onViewportLoad(tiles) {
        tileLoadCallbacks?.onViewportTilesRequested?.(tiles?.length ?? 0);
      },
      async getTileData({ bbox, signal }: PointTileLoadProps) {
        if (!isPointTileBbox(bbox)) {
          return null;
        }
        tileLoadCallbacks?.onTileLoadStart?.();
        const rawBounds = boundsFromTileBbox(bbox);
        const bounds = intersectBounds(rawBounds, localBounds);
        if (!bounds) {
          tileLoadCallbacks?.onTileLoadEnd?.(true);
          return null;
        }
        try {
          const result = await element.loadPointsInBounds({ bounds, featureCodes, signal });
          tileLoadCallbacks?.onTileLoadEnd?.(true);
          return result;
        } catch (error) {
          tileLoadCallbacks?.onTileLoadEnd?.(false);
          if (signal?.aborted || isAbortError(error)) {
            return null;
          }
          throw error;
        }
      },
      renderSubLayers: (props: {
        id: string;
        data?: PointData | null;
        tile?: { bbox?: unknown };
      }) => {
        if (!props.data) {
          return null;
        }
        const tileBbox = isPointTileBbox(props.tile?.bbox) ? props.tile.bbox : null;
        return renderPointScatterSubLayer(`${props.id}-scatter`, props.data, {
          ...scatterStyleProps,
          tileBounds: tileBbox ? scatterBoundsFromTileBbox(tileBbox) : undefined,
          tileSubLayer: true,
        });
      },
    });
  }

  return renderPointScatterSubLayer(id, pointData, scatterStyleProps);
}
