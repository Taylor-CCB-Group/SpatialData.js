import { describe, expect, it } from 'vitest';
import { renderRasterImageTile } from '../src/webgpu/deviceAdaptiveImageLayer';
import { RasterTileLayer } from '../src/webgpu/RasterTileLayer';

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
    expect(layer?.props.channelData.data.map((plane: Uint8Array) => [...plane])).toEqual([
      [255, 0],
      [0, 128],
      [0, 128],
    ]);
    expect(layer?.props.contrastLimits).toEqual([
      [0, 255],
      [0, 255],
      [0, 255],
    ]);
  });

  it('reuses the planes when the same tile data renders again', () => {
    const data = { data: new Uint8Array(2 * 2 * 3), width: 2, height: 2 };
    const first = renderRasterImageTile(tileProps(data));
    const second = renderRasterImageTile(tileProps(data));
    expect(second?.props.channelData).toBe(first?.props.channelData);
  });

  it('passes channel planes through unchanged', () => {
    const data = { data: [new Uint16Array(4), new Uint16Array(4)], width: 2, height: 2 };
    expect(renderRasterImageTile(tileProps(data))?.props.channelData).toBe(data);
  });
});
