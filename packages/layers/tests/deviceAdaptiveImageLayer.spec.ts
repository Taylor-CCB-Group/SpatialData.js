import { describe, expect, it } from 'vitest';
import { renderRasterImageTile } from '../src/webgpu/deviceAdaptiveImageLayer';
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
