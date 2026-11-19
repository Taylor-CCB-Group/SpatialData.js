/** Layers shared by the isolated-group demos (`/groups`, `/groupgrid`). */

import { ScatterplotLayer } from '@deck.gl/layers';
import { Matrix4 } from '@math.gl/core';
import type { VivImageLayerConfig } from '../../src/index';

export type Rgb = [number, number, number];
export type Circle = { position: [number, number]; radius: number; color: Rgb };

export const RED: Rgb = [230, 40, 40];
export const GREEN: Rgb = [40, 200, 60];
export const BACKDROP: Rgb = [60, 120, 200];

export function circles(id: string, data: Circle[], opacity: number): ScatterplotLayer<Circle> {
  return new ScatterplotLayer<Circle>({
    id,
    data,
    getPosition: (d) => d.position,
    getRadius: (d) => d.radius,
    getFillColor: (d) => d.color,
    updateTriggers: { getFillColor: data.map((d) => d.color.join()).join('|') },
    opacity,
    pickable: true,
    autoHighlight: true,
    highlightColor: [255, 255, 0, 255],
  });
}

const IMAGE_SIZE = 256;
export const IMAGE_VALUE = 200;
/** World placement of the image: x 60..316, y -128..128, under the group's circles. */
const IMAGE_ORIGIN: [number, number, number] = [60, -128, 0];

/** A one-channel uint8 Viv pixel source filled with `IMAGE_VALUE`, with `levels`
 *  resolutions; more than one makes Viv tile it (`MultiscaleImageLayer`). Tiles arrive
 *  after `tileDelayMs`, to show a late tile reaching an already-drawn target. */
export function syntheticImageLoader(tileDelayMs = 0, levels = 1) {
  const tileSize = levels > 1 ? IMAGE_SIZE / 2 : IMAGE_SIZE;
  const filled = async (width: number, height: number) => {
    if (tileDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, tileDelayMs));
    return { data: new Uint8Array(width * height).fill(IMAGE_VALUE), width, height };
  };
  return Array.from({ length: levels }, (_, level) => {
    const size = IMAGE_SIZE >> level;
    const tile = Math.min(tileSize, size);
    return {
      shape: [1, size, size],
      labels: ['c', 'y', 'x'],
      tileSize,
      dtype: 'Uint8',
      meta: {},
      getTile: () => filled(tile, tile),
      getRaster: () => filled(size, size),
      onTileError: (error: unknown) => console.error(error),
    };
  });
}

/** The synthetic image as a `VivSpatialViewer` image config. */
export function syntheticImageConfig(
  loader: unknown,
  extra: Partial<VivImageLayerConfig> = {}
): VivImageLayerConfig {
  return {
    id: 'image',
    loader,
    colors: [[255, 255, 255]],
    contrastLimits: [[0, 255]],
    channelsVisible: [true],
    selections: [{ c: 0 }],
    modelMatrix: new Matrix4().translate(IMAGE_ORIGIN),
    ...extra,
  };
}
