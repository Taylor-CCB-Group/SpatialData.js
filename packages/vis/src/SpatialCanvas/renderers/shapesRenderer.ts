/**
 * Transitional shapes renderer.
 *
 * The authoritative deck-facing styling/filtering logic now lives in
 * `@spatialdata/layers`. This adapter keeps SpatialCanvas consuming the shared
 * layer contract while the rest of the viewer migrates.
 */

import type { Matrix4 } from '@math.gl/core';
import type { ShapesElement, ShapesRenderData, SpatialFeatureTooltipData } from '@spatialdata/core';
import { createShapesDeckLayer } from '@spatialdata/layers';
import type { Layer } from 'deck.gl';

export type ShapeTooltipDatum = SpatialFeatureTooltipData;

export interface ShapesLayerRenderConfig {
  /** The shapes element to render */
  element: ShapesElement;
  /** Unique layer ID */
  id: string;
  /** Transformation matrix to target coordinate system */
  modelMatrix: Matrix4;
  /** Layer opacity (0-1) */
  opacity: number;
  /** Whether layer is visible */
  visible: boolean;
  /** Fallback fill color [r, g, b, a] (0-255) */
  fillColor?: [number, number, number, number];
  /** Fallback stroke color [r, g, b, a] (0-255) */
  strokeColor?: [number, number, number, number];
  /** Fallback stroke width in pixels */
  strokeWidth?: number;
  featureState?: {
    fillColorByFeatureId?: Record<string, [number, number, number, number]>;
    strokeColorByFeatureId?: Record<string, [number, number, number, number]>;
    hiddenFeatureIds?: string[];
    fadedFeatureIds?: string[];
    filteredOpacityMultiplier?: number;
  };
  renderData?: ShapesRenderData;
}

/**
 * Create a deck.gl PolygonLayer for shapes data.
 *
 * Note: This requires the polygon data to be pre-loaded since deck.gl layers
 * are synchronous. The data loading should happen at a higher level.
 */
export function renderShapesLayer(config: ShapesLayerRenderConfig): Layer | null {
  const {
    id,
    modelMatrix,
    opacity,
    visible,
    fillColor = [100, 100, 200, 180],
    strokeColor = [255, 255, 255, 255],
    strokeWidth = 1,
    featureState,
    renderData,
  } = config;

  if (!visible) return null;
  if (!renderData) {
    return null;
  }

  return createShapesDeckLayer(
    renderData,
    {
      kind: 'shapes',
      elementKey: renderData.elementKey,
      visible,
      defaultFillColor: fillColor,
      defaultStrokeColor: strokeColor,
      defaultStrokeWidth: strokeWidth,
      featureState,
    },
    {
      id,
      visible,
      opacity,
      modelMatrix,
    }
  );
}

/**
 * Load polygon data from a shapes element.
 * This is async and should be called during component setup.
 */
export async function loadShapesData(element: ShapesElement): Promise<ShapesRenderData> {
  try {
    return await element.loadRenderData();
  } catch (error) {
    console.warn(
      `[ShapesRenderer] Failed to load shapes from ${element.url ?? element.path}:`,
      error
    );
    return {
      kind: 'js-polygons',
      elementKey: element.key,
      featureIds: [],
      polygons: [],
      rowIndexByFeatureIndex: new Int32Array(0),
    };
  }
}
