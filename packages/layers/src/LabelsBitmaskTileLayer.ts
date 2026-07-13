import type { GetPickingInfoParams, PickingInfo } from '@deck.gl/core';
import { picking, project32 } from '@deck.gl/core';
import { XRLayer } from '@hms-dbmi/viv';
import { Matrix4 } from '@math.gl/core';
import { fs, labelsBitmaskUniforms, vs } from './labelsBitmaskLayerShaders';

function getNormalizedColor(color?: readonly number[]): [number, number, number] {
  if (!color || color.length < 3) {
    return [0, 0, 0];
  }
  return [color[0] / 255, color[1] / 255, color[2] / 255];
}

function getLabelCoordinate(
  coordinate: number[] | undefined,
  modelMatrix: unknown
): [number, number, number] | null {
  if (!coordinate || coordinate.length < 2) {
    return null;
  }
  const point: [number, number, number] = [
    coordinate[0] ?? 0,
    coordinate[1] ?? 0,
    coordinate[2] ?? 0,
  ];
  if (!modelMatrix) {
    return point;
  }
  try {
    return new Matrix4(modelMatrix as any).invert().transformAsPoint(point) as [
      number,
      number,
      number,
    ];
  } catch {
    return point;
  }
}

function getLabelAtPixel(
  props: any,
  pixelX: number,
  pixelY: number
): { labelId: number; selection?: unknown } | null {
  const { channelData, channelsVisible, selections } = props;
  const plane = channelData?.data?.[0];
  const width = channelData?.width;
  const height = channelData?.height;
  if (!plane?.length || !width || !height) {
    return null;
  }
  if (!(channelsVisible?.[0] ?? true)) {
    return null;
  }
  const pixelIndex = pixelY * width + pixelX;
  const labelValue = Number(plane[pixelIndex] ?? 0);
  if (!Number.isFinite(labelValue) || labelValue <= 0) {
    return null;
  }
  return { labelId: labelValue, selection: selections?.[0] };
}

const UntypedXRLayer = XRLayer as any;

export class LabelsBitmaskTileLayer extends UntypedXRLayer {
  static layerName = 'LabelsBitmaskTileLayer';

  static defaultProps = {
    channelColors: { type: 'array', value: [[255, 255, 255]], compare: true },
    channelsFilled: { type: 'array', value: [true], compare: true },
    channelOpacities: { type: 'array', value: [0.18], compare: true },
    channelOutlineOpacities: { type: 'array', value: [0.95], compare: true },
    channelsVisible: { type: 'array', value: [true], compare: true },
    channelStrokeWidths: { type: 'array', value: [1.5], compare: true },
  };

  // biome-ignore lint/complexity/noUselessConstructor: widens the base UntypedXRLayer constructor so `new LabelsBitmaskTileLayer(props)` typechecks.
  constructor(...args: any[]) {
    super(...args);
  }

  /** One instance-ID plane; matches SpatialData labels + `get_table_keys` contract. */
  getNumChannels(): number {
    return 1;
  }

  getShaders(): any {
    return {
      fs,
      vs,
      modules: [project32, picking, labelsBitmaskUniforms],
      defines: { NUM_CHANNELS: '1' },
    };
  }

  getPickingInfo(params: GetPickingInfoParams): PickingInfo {
    const info = super.getPickingInfo(params);
    const localCoordinate = getLabelCoordinate(
      info.coordinate as number[] | undefined,
      this.props.modelMatrix
    );
    const { bounds, channelData } = this.props;
    const width = channelData?.width;
    const height = channelData?.height;

    if (
      !localCoordinate ||
      !bounds ||
      !width ||
      !height ||
      !Number.isFinite(bounds[0]) ||
      !Number.isFinite(bounds[1]) ||
      !Number.isFinite(bounds[2]) ||
      !Number.isFinite(bounds[3])
    ) {
      return info;
    }

    const xDenominator = bounds[2] - bounds[0];
    const yDenominator = bounds[1] - bounds[3];
    if (xDenominator === 0 || yDenominator === 0) {
      return info;
    }

    const u = (localCoordinate[0] - bounds[0]) / xDenominator;
    const v = (localCoordinate[1] - bounds[3]) / yDenominator;
    if (!(u >= 0 && u <= 1 && v >= 0 && v <= 1)) {
      return info;
    }

    const pixelX = Math.max(0, Math.min(width - 1, Math.floor(u * width)));
    const pixelY = Math.max(0, Math.min(height - 1, Math.floor(v * height)));
    const pickedLabel = getLabelAtPixel(this.props, pixelX, pixelY);
    if (!pickedLabel) {
      info.object = null;
      return info;
    }

    info.object = {
      ...pickedLabel,
      channelIndex: 0,
      pixel: [pixelX, pixelY] as const,
    };
    info.index = 0;
    return info;
  }

  dataToTexture(data: unknown, width: number, height: number) {
    return this.context.device.createTexture({
      width,
      height,
      dimension: '2d',
      data: new Float32Array(data as ArrayLike<number>),
      mipmaps: false,
      sampler: {
        minFilter: 'nearest',
        magFilter: 'nearest',
        addressModeU: 'clamp-to-edge',
        addressModeV: 'clamp-to-edge',
      },
      format: 'r32float',
    });
  }

  loadChannelTextures(channelData: { data?: unknown[]; width: number; height: number }) {
    const textures: Record<string, unknown> = { channel0: null };

    if (this.state.textures) {
      Object.values(this.state.textures as Record<string, { delete?: () => void } | null>).forEach(
        (tex) => {
          tex?.delete?.();
        }
      );
    }

    const plane = channelData?.data?.[0];
    if (plane && channelData.width && channelData.height) {
      textures.channel0 = this.dataToTexture(plane, channelData.width, channelData.height);
      (this as any)._setNewTexturesFromLoadThisFrame?.(textures);
      this.setState({ textures });
      return;
    }

    (this as any)._setNewTexturesFromLoadThisFrame?.(null);
  }

  draw(_opts: { uniforms?: Record<string, unknown> }) {
    const { model, textures } = this.state as {
      model?: {
        shaderInputs?: { setProps: (props: Record<string, unknown>) => void };
        setUniforms?: (uniforms: Record<string, unknown>, opts?: Record<string, unknown>) => void;
        setBindings: (bindings: Record<string, unknown>) => void;
        draw: (renderPass?: unknown) => void;
      };
      textures?: Record<string, { width: number; height: number } | null>;
    };
    if (!model || !textures) {
      return;
    }

    const {
      channelColors,
      channelsFilled,
      channelOpacities,
      channelOutlineOpacities,
      channelsVisible,
      channelStrokeWidths,
      maxZoom,
      opacity = 1,
      zoom,
    } = this.props;

    const color = getNormalizedColor(channelColors?.[0] ?? [255, 255, 255]);
    const zoomDelta = typeof zoom === 'number' && typeof maxZoom === 'number' ? maxZoom - zoom : 0;
    const scaleFactor = 1 / 2 ** zoomDelta;

    const labelsBitmask = {
      color0: [...color, 1] as const,
      channelFilled0: (channelsFilled?.[0] ?? true) ? 1 : 0,
      channelOpacity0: channelOpacities?.[0] ?? 0.18,
      channelOutlineOpacity0: channelOutlineOpacities?.[0] ?? 0.95,
      channelVisible0: (channelsVisible?.[0] ?? true) ? 1 : 0,
      channelStrokeWidth0: channelStrokeWidths?.[0] ?? 1.5,
      scaleFactor,
      labelOpacity: opacity,
    };

    model.shaderInputs?.setProps({ labelsBitmask });
    model.setUniforms?.(_opts.uniforms ?? {}, { disableWarnings: false });
    model.setBindings(textures);
    model.draw((this.context as { renderPass?: unknown }).renderPass);
  }
}
