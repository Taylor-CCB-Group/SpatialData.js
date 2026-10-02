import type { Layer } from '@deck.gl/core';
import { CompositeLayer } from '@deck.gl/core';
import { ImageLayer } from '@hms-dbmi/viv';
import { RasterTileLayer } from './RasterTileLayer';

const RGB_PROPS = {
  colors: [
    [255, 0, 0],
    [0, 255, 0],
    [0, 0, 255],
  ],
  channelsVisible: [true, true, true],
};

type RgbPlanes = ReturnType<typeof splitRgb>;

/** Keyed by the source array, so re-renders keep the same planes and skip re-uploads. */
const rgbCache = new WeakMap<Uint8Array | Uint16Array, RgbPlanes>();

/**
 * Viv hands interleaved RGB(A) images (last dimension 3 or 4) over as one typed array
 * where it would otherwise give one plane per channel; Viv draws them with a GLSL
 * BitmapLayer. Here they are split into R, G and B planes and composited additively,
 * which reproduces the colour. Alpha, and photometric interpretations other than RGB
 * (Viv's `photometricInterpretation` shader), are not handled.
 */
function deinterleaveRgb(data: unknown, width: number, height: number): RgbPlanes {
  if (!(data instanceof Uint8Array || data instanceof Uint16Array)) {
    return null;
  }
  let planes = rgbCache.get(data);
  if (planes === undefined) {
    planes = splitRgb(data, width, height);
    rgbCache.set(data, planes);
  }
  return planes;
}

function splitRgb(data: Uint8Array | Uint16Array, width: number, height: number) {
  const pixels = width * height;
  const components = Math.round(data.length / pixels);
  if (components < 3) {
    return null;
  }
  const makePlane = () =>
    data instanceof Uint16Array ? new Uint16Array(pixels) : new Uint8Array(pixels);
  const planes = [makePlane(), makePlane(), makePlane()];
  for (let i = 0; i < pixels; i++) {
    for (let c = 0; c < 3; c++) {
      planes[c][i] = data[i * components + c];
    }
  }
  const max = data instanceof Uint16Array ? 65535 : 255;
  return {
    channelData: { data: planes, width, height },
    contrastLimits: planes.map(() => [0, max]),
    ...RGB_PROPS,
  };
}

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
  const rgb = Array.isArray(data.data) ? null : deinterleaveRgb(data.data, data.width, data.height);
  if (!Array.isArray(data.data) && !rgb) {
    return null;
  }
  const scale = 2 ** Math.round(-z);
  const bounds = [left, top + data.height * scale, left + data.width * scale, top];
  return new RasterTileLayer(props, {
    mode: 'image',
    channelData: data,
    ...rgb,
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
    if (!(width && height)) {
      return null;
    }
    const rgb = Array.isArray(data) ? null : deinterleaveRgb(data, width, height);
    if (!Array.isArray(data) && !rgb) {
      return null;
    }
    const bounds = [0, height, width, 0];
    return new RasterTileLayer(this.props, {
      mode: 'image',
      channelData: { data, width, height },
      ...rgb,
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
