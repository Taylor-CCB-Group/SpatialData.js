/**
 * Points layer renderer adapter for SpatialCanvas.
 */

import type { Matrix4 } from '@math.gl/core';
import { PointsLayer, type PointsRenderResource, type TileDebugStore } from '@spatialdata/layers';
import type { Layer } from 'deck.gl';

export {
  DEFAULT_POINT_RADIUS_MAX_PIXELS,
  DEFAULT_POINT_RADIUS_MIN_PIXELS,
  DEFAULT_POINT_SIZE,
  MIN_POINT_SIZE_SCALE,
  POINT_SIZE_ZOOM_REFERENCE,
  zoomScaledPointSize,
} from '@spatialdata/layers';

export type { PointData } from '@spatialdata/layers';

export interface PointsLayerRenderConfig {
  /** Resolved points render resource from the Resource Resolver. */
  resource: PointsRenderResource;
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
  preloadedFeatureCodes?: ArrayLike<number>;
  renderCap?: number;
  showTileDebugOverlay?: boolean;
  tileDebugStore?: TileDebugStore;
  tileDebugSignature?: string;
  use3d?: boolean;
}

export function renderPointsLayer(config: PointsLayerRenderConfig): Layer | null {
  const {
    resource,
    id,
    modelMatrix,
    opacity,
    visible,
    pointSize,
    pointRadiusMinPixels,
    pointRadiusMaxPixels,
    pointMinSizeScale,
    viewZoom,
    color,
    featureCodes,
    preloadedFeatureCodes,
    renderCap,
    showTileDebugOverlay,
    tileDebugStore,
    tileDebugSignature,
    use3d,
  } = config;

  if (!visible) {
    return null;
  }

  if (
    !resource.loader.capabilities.bounds &&
    resource.loader.capabilities.kind === 'morton-tiled'
  ) {
    console.debug(
      `[PointsRenderer] No tiling bounds for layer "${id}" from ${resource.element.path}`
    );
    return null;
  }

  return new PointsLayer({
    id,
    resource,
    modelMatrix,
    opacity,
    visible,
    pointSize,
    pointRadiusMinPixels,
    pointRadiusMaxPixels,
    pointMinSizeScale,
    viewZoom,
    color,
    featureCodes,
    preloadedFeatureCodes,
    renderCap,
    showTileDebugOverlay: showTileDebugOverlay ?? true,
    tileDebugStore,
    tileDebugSignature,
    use3d,
  });
}
