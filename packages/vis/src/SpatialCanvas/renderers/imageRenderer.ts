/**
 * Image layer renderer using Viv
 * 
 * This renderer creates Viv MultiscaleImageLayer instances for displaying
 * OME-Zarr and other multiscale image formats.
 */

import { getOrCreateOmeZarrMultiscalesLoader } from '@spatialdata/avivatorish';
import type { Matrix4 } from '@math.gl/core';
import type { ImageElement } from '@spatialdata/core';
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
export function renderImageLayer(config: ImageLayerRenderConfig): Layer | null {
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
  const defaults = {
    colors: [[255, 255, 255]] as [number, number, number][],
    contrastLimits: [[0, 65535]] as [number, number][],
    channelsVisible: [true],
    // Don't provide default selections - they should be built from loader dimensions
    // TODO - fix types wrt optional entries
    selections: [] as Partial<{ z: number; c: number; t: number }>[],
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
  element: ImageElement,
  fetchMultiscales: (url: string) => Promise<unknown> = getOrCreateOmeZarrMultiscalesLoader,
): Promise<unknown> {
  try {
    return await fetchMultiscales(element.url);
  } catch (error) {
    console.error(`[ImageRenderer] Failed to create loader for ${element.url}:`, error);
    throw error;
  }
}

