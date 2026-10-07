/** Layers shared by the isolated-group demos (`/groups`, `/groupgrid`). */

import { Layer } from '@deck.gl/core';
import { ScatterplotLayer } from '@deck.gl/layers';
import { ScaleBarLayer } from '@hms-dbmi/viv';
import { Matrix4 } from '@math.gl/core';
import { DeviceAdaptiveImageLayer } from '@spatialdata/layers';
import { DetailView } from '@vivjs/views';

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

/** A one-level, one-channel uint8 Viv pixel source filled with `IMAGE_VALUE`. Its tile
 *  arrives after `tileDelayMs`, to show a late tile reaching an already-drawn target. */
export function syntheticImageLoader(tileDelayMs = 0) {
  const filled = async () => {
    if (tileDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, tileDelayMs));
    return new Uint8Array(IMAGE_SIZE * IMAGE_SIZE).fill(IMAGE_VALUE);
  };
  return [
    {
      shape: [1, IMAGE_SIZE, IMAGE_SIZE],
      labels: ['c', 'y', 'x'],
      tileSize: IMAGE_SIZE,
      dtype: 'Uint8',
      meta: {},
      getTile: async () => ({ data: await filled(), width: IMAGE_SIZE, height: IMAGE_SIZE }),
      getRaster: async () => ({ data: await filled(), width: IMAGE_SIZE, height: IMAGE_SIZE }),
      onTileError: (error: unknown) => console.error(error),
    },
  ];
}

/**
 * Viv image layers built the way `VivSpatialViewer` builds them: `DetailView.getLayers`,
 * each wrapped in `DeviceAdaptiveImageLayer`. `idSuffix` is appended to each id.
 */
export function vivImageLayers(
  loader: unknown,
  idSuffix: string,
  width: number,
  height: number
): Layer[] {
  const detail = new DetailView({ id: `image${idSuffix}`, width, height });
  const result: unknown = detail.getLayers({
    props: {
      loader,
      colors: [[255, 255, 255]],
      contrastLimits: [[0, 255]],
      channelsVisible: [true],
      selections: [{ c: 0 }],
      modelMatrix: new Matrix4().translate(IMAGE_ORIGIN),
    },
  });
  const vivLayers = (Array.isArray(result) ? result.flat(Infinity) : [result]).filter(
    (layer): layer is Layer => layer instanceof Layer && !(layer instanceof ScaleBarLayer)
  );
  return vivLayers.map(
    (vivLayer) => new DeviceAdaptiveImageLayer({ id: `${vivLayer.id}-device${idSuffix}`, vivLayer })
  );
}
