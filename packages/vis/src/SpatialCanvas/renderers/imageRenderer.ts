/**
 * Image layer renderer using Viv
 *
 * This renderer creates Viv MultiscaleImageLayer instances for displaying
 * OME-Zarr and other multiscale image formats.
 */

import type { Matrix4 } from '@math.gl/core';
import {
  loadOmeZarrMultiscalesData,
  type OmeZarrMultiscalesSource,
} from '@spatialdata/avivatorish';
import type { ImageElement, LabelsElement } from '@spatialdata/core';
import type { Layer } from 'deck.gl';

export interface ImageLayerRenderConfig {
  /** The image element to render */
  element: ImageElement;
  /** Unique layer ID */
  id: string;
  /** Transformation matrix to target coordinate system */
  modelMatrix: Matrix4;
  /** Layer opacity (0-1) */
  opacity: number;
  /** Whether layer is visible */
  visible: boolean;
  /** Optional: Viv loader if already created */
  loader?: unknown;
  /** Optional: Channel configuration */
  channels?: {
    colors: [number, number, number][];
    contrastLimits: [number, number][];
    channelsVisible: boolean[];
    selections: Partial<{ z: number; c: number; t: number }>[];
  };
}

/**
 * Create a Viv image layer for rendering.
 *
 * Note: Actual layer creation happens in the viewer via Viv's view system.
 * This function is kept for API consistency but returns null - layers are
 * created by calling view.getLayers() in the viewer component.
 */
export function renderImageLayer(_config: ImageLayerRenderConfig): Layer | null {
  // Image layers are handled via Viv's view.getLayers() system in the viewer
  // This function exists for API consistency but doesn't create layers directly
  return null;
}

/**
 * Extract channel configuration from layer config, providing defaults if needed.
 */
export function extractChannelConfig(config: {
  channels?: {
    colors?: [number, number, number][];
    contrastLimits?: [number, number][];
    channelsVisible?: boolean[];
    selections?: Partial<{ z: number; c: number; t: number }>[];
  };
}): {
  colors: [number, number, number][];
  contrastLimits: [number, number][];
  channelsVisible: boolean[];
  selections: Partial<{ z: number; c: number; t: number }>[];
} {
  const defaults: {
    colors: [number, number, number][];
    contrastLimits: [number, number][];
    channelsVisible: boolean[];
    selections: Partial<{ z: number; c: number; t: number }>[];
  } = {
    colors: [[255, 255, 255]],
    contrastLimits: [[0, 65535]],
    channelsVisible: [true],
    // Don't provide default selections - they should be built from loader dimensions
    // TODO - fix types wrt optional entries
    selections: [],
  };

  if (!config.channels) {
    return defaults;
  }

  return {
    colors: config.channels.colors ?? defaults.colors,
    contrastLimits: config.channels.contrastLimits ?? defaults.contrastLimits,
    channelsVisible: config.channels.channelsVisible ?? defaults.channelsVisible,
    selections: config.channels.selections ?? defaults.selections,
  };
}

/**
 * Create a Viv loader for an image element.
 * This is async and should be called during component setup.
 *
 * SpatialData only supports OME-Zarr format, so we use loadOmeZarr.
 */
export async function createImageLoader(
  element: ImageElement | LabelsElement,
  fetchMultiscales: (
    source: OmeZarrMultiscalesSource
  ) => Promise<unknown> = loadOmeZarrMultiscalesData
): Promise<unknown> {
  const store = element.getStore();

  if (!store && !element.url) {
    throw new Error(
      `SpatialCanvas requires a store-backed or URL-backed raster source for '${element.path}'.`
    );
  }

  try {
    return await fetchMultiscales({ store, url: element.url });
  } catch (error) {
    console.error(
      `[ImageRenderer] Failed to create loader for ${element.url ?? element.path}:`,
      error
    );
    throw error;
  }
}
