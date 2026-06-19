/**
 * Points layer renderer using deck.gl ScatterplotLayer
 *
 * Renders point cloud data from SpatialData points elements.
 */

import type { Matrix4 } from '@math.gl/core';
import type { PointsElement, PointsTilingMetadata, SpatialBounds } from '@spatialdata/core';
import { ScatterplotLayer, TileLayer } from 'deck.gl';
import type { Layer } from 'deck.gl';

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
  /** Point color [r, g, b, a] (0-255) */
  color?: [number, number, number, number];
  /** ndarray - if we want other data for properties like color/radius etc they will be handled differently */
  pointData?: PointData;
  pointTilingMetadata?: PointsTilingMetadata;
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

function boundsFromTileBbox(bbox: unknown): SpatialBounds | null {
  if (!isPointTileBbox(bbox)) {
    return null;
  }
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
    opacity: number;
    modelMatrix: Matrix4;
    use3d?: boolean;
  }
) {
  const d = data.data;
  return new ScatterplotLayer({
    id,
    data: d[0],
    getPosition: (_d, { index, target }) => [
      d[0][index],
      d[1][index],
      props.use3d ? d[2]?.[index] || 0 : 0,
    ],
    getRadius: props.pointSize,
    radiusUnits: 'pixels',
    getFillColor: props.color,
    opacity: props.opacity,
    modelMatrix: props.modelMatrix,
    pickable: true,
    autoHighlight: true,
    highlightColor: [255, 255, 0, 200],
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
    pointSize = 1,
    color = [255, 100, 100, 200],
    pointData,
    pointTilingMetadata,
    use3d,
  } = config;

  if (!visible) return null;

  if (!pointData) {
    if (!pointTilingMetadata?.bounds) {
      console.debug(
        `[PointsRenderer] No point data for layer "${id}" from ${element.url ?? element.path}`
      );
      return null;
    }
    return new TileLayer({
      id,
      data: pointTilingMetadata.parquetPath,
      extent: [
        pointTilingMetadata.bounds.minX,
        pointTilingMetadata.bounds.minY,
        pointTilingMetadata.bounds.maxX,
        pointTilingMetadata.bounds.maxY,
      ],
      tileSize: 512,
      minZoom: -12,
      maxZoom: 12,
      refinementStrategy: 'best-available',
      updateTriggers: {
        getTileData: [element, pointTilingMetadata.parquetPath],
      },
      async getTileData({ bbox, signal }: PointTileLoadProps) {
        const bounds = boundsFromTileBbox(bbox);
        if (!bounds) {
          return null;
        }
        try {
          return await element.loadPointsInBounds({ bounds, signal });
        } catch (error) {
          if (signal?.aborted || isAbortError(error)) {
            return null;
          }
          throw error;
        }
      },
      renderSubLayers: (props: { id: string; data?: PointData | null }) => {
        if (!props.data) {
          return null;
        }
        return renderPointScatterSubLayer(`${props.id}-scatter`, props.data, {
          color,
          pointSize,
          opacity,
          modelMatrix,
          use3d,
        });
      },
    });
  }

  if (!pointData) {
    return null;
  }
  return renderPointScatterSubLayer(id, pointData, {
    color,
    pointSize,
    opacity,
    modelMatrix,
    use3d,
  });
}
