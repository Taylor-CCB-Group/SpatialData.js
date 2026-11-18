import type { Layer } from '@deck.gl/core';
import { ScatterplotLayer } from '@deck.gl/layers';
import { ImageLayer } from '@hms-dbmi/viv';
import { describe, expect, it } from 'vitest';
import { IsolatedGroupLayer } from '../src/groups/IsolatedGroupLayer';
import {
  DeviceAdaptiveImageLayer,
  renderRasterImageTile,
} from '../src/webgpu/deviceAdaptiveImageLayer';
import { RasterTileLayer } from '../src/webgpu/RasterTileLayer';

/**
 * `renderRasterImageTile` returns a plain deck `Layer`, whose declared props lack
 * RasterTileLayer's own; read them through this view.
 */
interface RasterTileProps {
  channelData: { data: Uint8Array[] };
  contrastLimits: number[][];
}

function rasterProps(layer: ReturnType<typeof renderRasterImageTile>): RasterTileProps | undefined {
  // RasterTileLayer is an untyped (`any`-based) deck subclass, so the compiler cannot see its props.
  return layer ? (layer.props as unknown as RasterTileProps) : undefined;
}

function tileProps(data: unknown) {
  return {
    id: 'image',
    maxZoom: 0,
    tile: { bbox: { left: 0, top: 0 }, index: { x: 0, y: 0, z: 0 } },
    data,
  };
}

describe('renderRasterImageTile', () => {
  it('splits an interleaved RGBA tile into R, G and B planes', () => {
    // Two pixels: opaque red, then half-transparent teal.
    const interleaved = new Uint8Array([255, 0, 0, 255, 0, 128, 128, 64]);
    const layer = renderRasterImageTile(tileProps({ data: interleaved, width: 2, height: 1 }));

    expect(layer).toBeInstanceOf(RasterTileLayer);
    expect(rasterProps(layer)?.channelData.data.map((plane) => [...plane])).toEqual([
      [255, 0],
      [0, 128],
      [0, 128],
    ]);
    expect(rasterProps(layer)?.contrastLimits).toEqual([
      [0, 255],
      [0, 255],
      [0, 255],
    ]);
  });

  it('reuses the planes when the same tile data renders again', () => {
    const data = { data: new Uint8Array(2 * 2 * 3), width: 2, height: 2 };
    const first = renderRasterImageTile(tileProps(data));
    const second = renderRasterImageTile(tileProps(data));
    expect(rasterProps(second)?.channelData).toBe(rasterProps(first)?.channelData);
  });

  it('passes channel planes through unchanged', () => {
    const data = { data: [new Uint16Array(4), new Uint16Array(4)], width: 2, height: 2 };
    expect(rasterProps(renderRasterImageTile(tileProps(data)))?.channelData).toBe(data);
  });
});

describe('DeviceAdaptiveImageLayer in a group', () => {
  const pixel = { data: new Uint8Array(1), width: 1, height: 1 };

  /** The layer a group draws for its one member, as deck would render it on `device`. */
  function drawnImage(groupId: string | null, vivLayer: Layer, device: 'webgl' | 'webgpu') {
    const image = new DeviceAdaptiveImageLayer({ id: 'img-device', vivLayer });
    const member = groupId
      ? new IsolatedGroupLayer({ id: groupId, layers: [image] }).renderLayers().flat()[0]
      : image;
    if (!(member instanceof DeviceAdaptiveImageLayer)) throw new Error('expected the image');
    // LayerManager sets the context; renderLayers reads only the device type.
    Object.defineProperty(member, 'context', { value: { device: { type: device } } });
    return member.renderLayers();
  }

  // deck matches layers by id across the tree. Under Viv's own id, an image moved into
  // a group kept its ungrouped instance and drew outside the group (SpatialData.js#304).
  it.each([
    ['webgl', () => new ScatterplotLayer({ id: 'viv' })],
    ['webgpu', () => new ScatterplotLayer({ id: 'viv' })],
    [
      'webgpu',
      () =>
        new ImageLayer({
          id: 'viv',
          channelsVisible: [true],
          contrastLimits: [[0, 255]],
          selections: [{ c: 0 }],
          dtype: 'Uint8',
          loader: {
            getRaster: async () => pixel,
            getTile: async () => pixel,
            onTileError: () => {},
            shape: [1, 1, 1],
            dtype: 'Uint8',
            labels: ['c', 'y', 'x'],
            tileSize: 1,
          },
        }),
    ],
  ] as const)('draws the Viv layer under the group-scoped id on %s', (device, viv) => {
    const ids = [null, 'g1', 'g2'].map((group) => drawnImage(group, viv(), device).id);
    expect(ids[1].startsWith('g1/')).toBe(true);
    expect(ids[2].startsWith('g2/')).toBe(true);
    expect(new Set(ids).size).toBe(3);
  });
});
