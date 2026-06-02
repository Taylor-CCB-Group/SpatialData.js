/**
 * Transitional shapes renderer.
 *
 * The authoritative deck-facing styling/filtering logic now lives in
 * `@spatialdata/layers`. This adapter keeps SpatialCanvas consuming the shared
 * layer contract while the rest of the viewer migrates.
 */

import type { Matrix4 } from '@math.gl/core';
import type { ShapesElement, ShapesRenderData, SpatialFeatureTooltipData } from '@spatialdata/core';
import {
  DEFAULT_SHAPE_STROKE_WIDTH,
  DEFAULT_SHAPE_STROKE_WIDTH_MAX_PIXELS,
  DEFAULT_SHAPE_STROKE_WIDTH_MIN_PIXELS,
  DEFAULT_SHAPE_STROKE_WIDTH_UNITS,
  type ShapeStrokeWidthUnits,
  type ShapeFeatureStateRuntime,
  type ShapesPrebuiltData,
  createShapesDeckLayer,
} from '@spatialdata/layers';
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
  /** Fallback stroke width in `strokeWidthUnits` */
  strokeWidth?: number;
  /** Units for polygon stroke width */
  strokeWidthUnits?: ShapeStrokeWidthUnits;
  /** Minimum rendered stroke width in screen pixels */
  strokeWidthMinPixels?: number;
  /** Maximum rendered stroke width in screen pixels */
  strokeWidthMaxPixels?: number;
  featureState?: {
    fillColorByFeatureId?: Record<string, [number, number, number, number]>;
    strokeColorByFeatureId?: Record<string, [number, number, number, number]>;
    hiddenFeatureIds?: string[];
    fadedFeatureIds?: string[];
    filteredOpacityMultiplier?: number;
  };
  renderData?: ShapesRenderData;
  /**
   * Pre-built data array from the load-path cache.
   * When provided, `createShapesDeckLayer` skips all O(n-features) data
   * construction and acts as a pure descriptor assembler.
   */
  prebuilt?: ShapesPrebuiltData;
  /**
   * Pre-built Map/Set runtime from the load-path cache. When provided, deck
   * layer assembly skips Record→Map conversion on every `getLayers()` call.
   */
  featureStateRuntime?: ShapeFeatureStateRuntime;
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
    strokeColor,
    strokeWidth = DEFAULT_SHAPE_STROKE_WIDTH,
    strokeWidthUnits = DEFAULT_SHAPE_STROKE_WIDTH_UNITS,
    strokeWidthMinPixels = DEFAULT_SHAPE_STROKE_WIDTH_MIN_PIXELS,
    strokeWidthMaxPixels = DEFAULT_SHAPE_STROKE_WIDTH_MAX_PIXELS,
    featureState,
    featureStateRuntime,
    renderData,
    prebuilt,
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
      defaultStrokeWidthUnits: strokeWidthUnits,
      defaultStrokeWidthMinPixels: strokeWidthMinPixels,
      defaultStrokeWidthMaxPixels: strokeWidthMaxPixels,
      featureState: featureStateRuntime ?? featureState,
    },
    {
      id,
      visible,
      opacity,
      modelMatrix,
    },
    prebuilt
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
    throw error instanceof Error
      ? error
      : new Error(
          `[ShapesRenderer] Failed to load shapes from ${element.url ?? element.path}: ${String(error)}`
        );
  }
}
