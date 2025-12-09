/**
 * Image layer renderer using Viv
 * 
 * This renderer creates Viv MultiscaleImageLayer instances for displaying
 * OME-Zarr and other multiscale image formats.
 */

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
    selections: { z: number; c: number; t: number }[];
  };
}

/**
 * Create a Viv image layer for rendering.
 * 
 * Note: Full Viv integration requires async loader creation and channel state.
 * This is a placeholder that returns null until the loader infrastructure is integrated.
 * 
 * TODO: 
 * - Integrate with Viv's loader creation (loadOmeZarr, etc.)
 * - Apply modelMatrix transformation
 * - Handle channel state
 */
export function renderImageLayer(config: ImageLayerRenderConfig): Layer | null {
  const { element, id, modelMatrix, opacity, visible, loader, channels } = config;

  if (!visible) return null;
  
  // Full implementation would create MultiscaleImageLayer here
  // For now, we return null and log the intent
  console.debug(`[ImageRenderer] Would render image layer "${id}" from ${element.url}`, {
    hasLoader: !!loader,
    hasChannels: !!channels,
    opacity,
    transform: modelMatrix.toArray(),
  });

  // Placeholder - actual implementation needs:
  // 1. Create/use Viv loader
  // 2. Get channel state from Viv stores or config
  // 3. Return MultiscaleImageLayer with modelMatrix
  
  return null;
}

/**
 * Create a Viv loader for an image element.
 * This is async and should be called during component setup.
 */
export async function createImageLoader(element: ImageElement): Promise<unknown> {
  // TODO: Use Viv's loadOmeZarr or similar based on element.url
  // This requires dynamic import of Viv loader utilities
  console.debug(`[ImageRenderer] Would create loader for ${element.url}`);
  return null;
}

