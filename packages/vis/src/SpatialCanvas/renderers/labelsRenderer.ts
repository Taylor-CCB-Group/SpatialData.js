/**
 * Labels layer renderer using a custom deck.gl bitmask layer.
 *
 * SpatialData labels are stored as raster segmentations, so we render them via
 * a custom MultiscaleImageLayer wrapper that colors non-zero label ids per
 * channel instead of showing the raw integer values as grayscale.
 */

import type { Matrix4 } from '@math.gl/core';
import { type LabelColorLut, LabelsLayer } from '@spatialdata/layers';
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
  /**
   * Per-label colour/visibility lookup table, pre-built by the projection and
   * identity-stable while its contents are unchanged. Absent means "no per-label
   * feature state" — the layer draws every label in the channel colour.
   */
  featureColorLut?: LabelColorLut;
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
    featureColorLut,
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
    ...(featureColorLut ? { featureColorLut } : {}),
  });
}
