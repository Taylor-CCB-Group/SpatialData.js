/**
 * Labels layer renderer using a custom deck.gl bitmask layer.
 *
 * SpatialData labels are stored as raster segmentations, so we render them via
 * a custom MultiscaleImageLayer wrapper that colors non-zero label ids per
 * channel instead of showing the raw integer values as grayscale.
 */

import { LabelsLayer } from '@spatialdata/layers';
import type { Matrix4 } from '@math.gl/core';
import type { Layer } from 'deck.gl';

export interface LabelsLayerRenderConfig {
  id: string;
  loader: unknown;
  modelMatrix: Matrix4;
  opacity: number;
  visible: boolean;
  channelColors: [number, number, number][];
  channelsVisible: boolean[];
  channelOpacities: number[];
  channelOutlineOpacities: number[];
  channelsFilled: boolean[];
  channelStrokeWidths: number[];
  selections: Partial<{ z: number; c: number; t: number }>[];
}

export function renderLabelsLayer(config: LabelsLayerRenderConfig): Layer | null {
  const {
    id,
    loader,
    modelMatrix,
    opacity,
    visible,
    channelColors,
    channelsVisible,
    channelOpacities,
    channelOutlineOpacities,
    channelsFilled,
    channelStrokeWidths,
    selections,
  } = config;

  if (!visible || !loader) {
    return null;
  }

  return new LabelsLayer({
    id,
    loader,
    modelMatrix,
    opacity,
    visible,
    channelColors,
    channelsVisible,
    channelOpacities,
    channelOutlineOpacities,
    channelsFilled,
    channelStrokeWidths,
    selections,
  });
}
