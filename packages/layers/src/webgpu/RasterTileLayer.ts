import type { GetPickingInfoParams, PickingInfo } from '@deck.gl/core';
import { color, Layer, picking, project32 } from '@deck.gl/core';
import { MAX_CHANNELS } from '@hms-dbmi/viv';
import type { Texture, TextureFormat } from '@luma.gl/core';
import { Model } from '@luma.gl/engine';
import { resolveLabelPickingInfo } from '../LabelsBitmaskTileLayer';
import {
  DEFAULT_LABEL_HIGHLIGHT_COLOR,
  LABEL_COLOR_LUT_WIDTH,
  type LabelColorLut,
  resolveHighlightedLabel,
} from '../labelColorEncoding';
import { rasterUniforms, source } from './rasterTileLayerShaders';

type Rgb = readonly number[];
type ChannelData = { data: ArrayLike<number>[]; width: number; height: number };

/** How the shader must read the samples back: native unsigned ints, or f32 bits. */
const VALUE_KIND = { uint: 0, floatBits: 1 } as const;

type UploadedPlanes = {
  format: TextureFormat;
  valueKind: number;
  planes: ArrayBufferView[];
};

/**
 * Pick the texture format for one tile's planes.
 *
 * Unsigned planes keep their width. Labels are ids, so signed/float label planes are
 * rounded into u32; image planes of any other type become f32 bit patterns.
 */
function preparePlanes(data: ArrayLike<number>[], mode: 'image' | 'labels'): UploadedPlanes {
  const first = data[0];
  if (first instanceof Uint8Array) {
    return { format: 'r8uint', valueKind: VALUE_KIND.uint, planes: data as Uint8Array[] };
  }
  if (first instanceof Uint16Array) {
    return { format: 'r16uint', valueKind: VALUE_KIND.uint, planes: data as Uint16Array[] };
  }
  if (first instanceof Uint32Array) {
    return { format: 'r32uint', valueKind: VALUE_KIND.uint, planes: data as Uint32Array[] };
  }
  if (mode === 'labels') {
    return {
      format: 'r32uint',
      valueKind: VALUE_KIND.uint,
      planes: data.map((plane) => Uint32Array.from(plane, (v) => Math.max(0, Math.round(v)))),
    };
  }
  return {
    format: 'r32uint',
    valueKind: VALUE_KIND.floatBits,
    planes: data.map((plane) => (plane instanceof Float32Array ? plane : Float32Array.from(plane))),
  };
}

function rgba(color: Rgb | undefined, alpha: number): [number, number, number, number] {
  return [(color?.[0] ?? 255) / 255, (color?.[1] ?? 255) / 255, (color?.[2] ?? 255) / 255, alpha];
}

const DEFAULT_PROPS = {
  mode: { type: 'string', value: 'image' },
  bounds: { type: 'array', value: [0, 0, 1, 1], compare: true },
  channelData: { type: 'object', value: null, compare: true },
  // image
  contrastLimits: { type: 'array', value: [], compare: true },
  colors: { type: 'array', value: [], compare: true },
  channelsVisible: { type: 'array', value: [], compare: true },
  interpolation: { type: 'string', value: 'nearest' },
  // labels — same prop names as LabelsBitmaskTileLayer so LabelsLayer can swap classes
  channelColors: { type: 'array', value: [[255, 255, 255]], compare: true },
  channelsFilled: { type: 'array', value: [true], compare: true },
  channelOpacities: { type: 'array', value: [0.18], compare: true },
  channelOutlineOpacities: { type: 'array', value: [0.95], compare: true },
  channelStrokeWidths: { type: 'array', value: [1.5], compare: true },
  featureColorLut: { type: 'object', value: null, compare: false },
  featureColorTexture: { type: 'object', value: null, compare: false },
  highlightedLabelId: { type: 'number', value: -1, compare: true },
  highlightColor: { type: 'array', value: DEFAULT_LABEL_HIGHLIGHT_COLOR, compare: true },
};

/**
 * WebGPU-only raster tile: a multichannel image, or a labels plane coloured through
 * the labels LUT. Drop-in for Viv's XRLayer (`mode: 'image'`) and for
 * `LabelsBitmaskTileLayer` (`mode: 'labels'`) when the deck device is WebGPU; it has
 * no GLSL, so the WebGL path keeps using those.
 */
// biome-ignore lint/suspicious/noExplicitAny: hand-rolled deck Layer subclass, as FlatPolygonLayer.
export class RasterTileLayer extends (Layer as any) {
  static layerName = 'RasterTileLayer';
  static defaultProps = DEFAULT_PROPS;

  // biome-ignore lint/complexity/noUselessConstructor: widens the `any` base constructor.
  // biome-ignore lint/suspicious/noExplicitAny: base widened to `any`.
  constructor(...args: any[]) {
    super(...args);
  }

  // biome-ignore lint/suspicious/noExplicitAny: matches base getShaders shape.
  getShaders(): any {
    return super.getShaders({ source, modules: [color, project32, picking, rasterUniforms] });
  }

  initializeState(): void {
    if (this.context.device.type !== 'webgpu') {
      throw new Error('RasterTileLayer is WGSL-only; use the Viv/labels layers on WebGL.');
    }
    this.state.model = this._getModel();
    this.state.fallbackLut = this.context.device.createTexture({
      width: 1,
      height: 1,
      format: 'rgba8unorm',
      data: new Uint8Array([0, 0, 0, 0]),
    });
    this._uploadPlanes();
  }

  // biome-ignore lint/suspicious/noExplicitAny: deck UpdateParameters over an `any` layer.
  updateState(params: any): void {
    super.updateState(params);
    const { props, oldProps } = params;
    if (props.channelData !== oldProps.channelData || props.mode !== oldProps.mode) {
      this._uploadPlanes();
    }
  }

  finalizeState(context: unknown): void {
    this.state.texture?.destroy();
    this.state.fallbackLut?.destroy();
    this.state.model?.destroy();
    super.finalizeState(context);
  }

  getPickingInfo(params: GetPickingInfoParams): PickingInfo {
    const info = super.getPickingInfo(params);
    return this.props.mode === 'labels' ? resolveLabelPickingInfo(info, this.props) : info;
  }

  _uploadPlanes(): void {
    this.state.texture?.destroy();
    this.state.texture = null;
    const channelData = this.props.channelData as ChannelData | null;
    const data = channelData?.data?.slice(0, MAX_CHANNELS);
    if (!channelData || !data?.length || !channelData.width || !channelData.height) {
      return;
    }
    const { width, height } = channelData;
    const { format, valueKind, planes } = preparePlanes(data, this.props.mode);
    const texture: Texture = this.context.device.createTexture({
      dimension: '2d-array',
      format,
      width,
      height,
      depth: planes.length,
      mipLevels: 1,
    });
    planes.forEach((plane, z) => {
      texture.writeData(plane, { z, width, height, depthOrArrayLayers: 1 });
    });
    this.state.texture = texture;
    this.state.valueKind = valueKind;
    this.state.numChannels = planes.length;
  }

  draw(): void {
    const { model, texture } = this.state;
    if (!model || !texture) {
      return;
    }
    const p = this.props;
    const opacity = p.opacity ?? 1;
    const mode = p.mode === 'labels' ? 1 : 0;

    const colors = Array.from({ length: MAX_CHANNELS }, (_, i) =>
      rgba(p.colors?.[i], i < this.state.numChannels && (p.channelsVisible?.[i] ?? true) ? 1 : 0)
    );
    const limits = Array.from(
      { length: MAX_CHANNELS },
      (_, i): [number, number, number, number] => {
        const [min, max] = p.contrastLimits?.[i] ?? [0, 1];
        return [min, max, 0, 0];
      }
    );
    const lut = p.featureColorLut as LabelColorLut | null;
    const useLut = lut && p.featureColorTexture ? 1 : 0;
    const highlight = (p.highlightColor as number[] | undefined) ?? DEFAULT_LABEL_HIGHLIGHT_COLOR;
    const labelVisible = p.channelsVisible?.[0] ?? true;

    model.shaderInputs.setProps({
      raster: {
        bounds: p.bounds,
        colors,
        limits,
        labelColor: rgba(p.channelColors?.[0], 1),
        highlightColor: rgba(highlight, (highlight[3] ?? 255) / 255),
        mode,
        numChannels: this.state.numChannels,
        valueKind: this.state.valueKind,
        linear: mode === 0 && p.interpolation === 'linear' ? 1 : 0,
        lutWidth: LABEL_COLOR_LUT_WIDTH,
        lutCount: useLut ? (lut?.count ?? 0) : 0,
        useLut,
        highlightedLabel: resolveHighlightedLabel(p.highlightedLabelId, lut ?? undefined),
        fillOpacity: (p.channelsFilled?.[0] ?? true) ? (p.channelOpacities?.[0] ?? 0.18) : 0,
        outlineOpacity: p.channelOutlineOpacities?.[0] ?? 0.95,
        strokeWidth: p.channelStrokeWidths?.[0] ?? 1.5,
        opacity: mode === 1 && !labelVisible ? 0 : opacity,
        rasterData: texture,
        rasterLut: useLut ? p.featureColorTexture : this.state.fallbackLut,
      },
    });
    model.draw(this.context.renderPass);
  }

  _getModel(): Model {
    return new Model(this.context.device, {
      ...this.getShaders(),
      id: this.props.id,
      topology: 'triangle-list',
      bufferLayout: [],
      isInstanced: false,
      vertexCount: 6,
      shaderAssembler: this.context.shaderAssembler,
    });
  }
}
