import type { Layer } from '@deck.gl/core';
import { CompositeLayer } from '@deck.gl/core';
import { ImageLayer } from '@hms-dbmi/viv';
import { RasterTileLayer } from './RasterTileLayer';

/**
 * Replacement for Viv's MultiscaleImageLayer `renderSubLayers` on WebGPU.
 *
 * Viv's own version returns an XRLayer (GLSL-only; its `initializeState` calls
 * `setParametersWebGL`, which throws on WebGPU). The tile bounds follow Viv's
 * (see its #975 note): scale the tile's own data size up to base resolution.
 */
// biome-ignore lint/suspicious/noExplicitAny: Viv's TileLayer sub-layer props are untyped.
export function renderRasterImageTile(props: any): Layer | null {
  const {
    bbox: { left, top },
    index: { x, y, z },
  } = props.tile;
  const { data, id, maxZoom } = props;
  if ([left, top].some((v: number) => v < 0) || !data || !data.width || !data.height) {
    return null;
  }
  if (!Array.isArray(data.data)) {
    // Interleaved RGB tiles arrive as one array. Not handled by the spike.
    return null;
  }
  const scale = 2 ** Math.round(-z);
  const bounds = [left, top + data.height * scale, left + data.width * scale, top];
  return new RasterTileLayer(props, {
    mode: 'image',
    channelData: data,
    bounds,
    id: `tile-sub-layer-${bounds}-${id}`,
    tileId: { x, y, z },
    interpolation: z === maxZoom ? 'nearest' : 'linear',
    extensions: [],
  }) as unknown as Layer;
}

// biome-ignore lint/suspicious/noExplicitAny: Viv's ImageLayer is untyped JS.
const UntypedImageLayer = ImageLayer as any;

/**
 * Viv's single-resolution ImageLayer with its GLSL XRLayer swapped for
 * `RasterTileLayer`; `getRaster` loading and abort handling are inherited.
 */
export class RasterImageLayer extends UntypedImageLayer {
  static layerName = 'RasterImageLayer';

  // biome-ignore lint/complexity/noUselessConstructor: widens the untyped base constructor.
  // biome-ignore lint/suspicious/noExplicitAny: base widened to `any`.
  constructor(...args: any[]) {
    super(...args);
  }

  renderLayers(): Layer | null {
    const { width, height, data } = this.state;
    if (!(width && height) || !Array.isArray(data)) {
      // Interleaved RGB arrives as one array; not handled by the spike.
      return null;
    }
    const bounds = [0, height, width, 0];
    return new RasterTileLayer(this.props, {
      mode: 'image',
      channelData: { data, width, height },
      bounds,
      id: `image-sub-layer-${bounds}-${this.props.id}`,
      extensions: [],
    }) as unknown as Layer;
  }
}

type DeviceAdaptiveImageLayerProps = {
  id: string;
  /** A Viv image layer as built for WebGL (e.g. from `DetailView.getLayers`). */
  vivLayer: Layer;
};

/**
 * Renders a Viv image layer unchanged on WebGL, and on WebGPU re-points its tiles at
 * `RasterTileLayer`. The device is only known once deck has one, so the choice is
 * made here in `renderLayers` rather than by whoever builds the Viv layer.
 *
 * On WebGPU, Viv `extensions` (ColorPalette, host GLSL extensions) are dropped — the
 * compositing they did is built into the WGSL — and the background layer is off,
 * since it is a hard-coded XRLayer. A single-resolution loader is Viv's ImageLayer,
 * which has no sub-layer seam, so it becomes `RasterImageLayer` instead.
 */
export class DeviceAdaptiveImageLayer extends CompositeLayer<DeviceAdaptiveImageLayerProps> {
  static layerName = 'DeviceAdaptiveImageLayer';

  renderLayers(): Layer {
    const { vivLayer } = this.props;
    if (this.context.device.type !== 'webgpu') {
      return vivLayer;
    }
    if (vivLayer instanceof ImageLayer) {
      return new RasterImageLayer({ ...vivLayer.props, extensions: [] }) as unknown as Layer;
    }
    return vivLayer.clone({
      renderSubLayers: renderRasterImageTile,
      excludeBackground: true,
      extensions: [],
      // biome-ignore lint/suspicious/noExplicitAny: Viv-only props not in deck's Layer props.
    } as any);
  }
}
