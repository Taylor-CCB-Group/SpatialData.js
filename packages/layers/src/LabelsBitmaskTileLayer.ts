import type { GetPickingInfoParams, PickingInfo } from '@deck.gl/core';
import { project32, picking } from '@deck.gl/core';
import { Matrix4 } from '@math.gl/core';
import { XRLayer } from '@hms-dbmi/viv';
import { fs, labelsBitmaskUniforms, vs } from './labelsBitmaskLayerShaders';

const MAX_LABEL_CHANNELS = 7;

function padWithDefault<T>(
  arr: readonly T[] | undefined,
  defaultValue: T,
  targetLength: number
): T[] {
  const next = arr ? [...arr] : [];
  while (next.length < targetLength) {
    next.push(defaultValue);
  }
  return next;
}

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

function getTopmostLabelAtPixel(
  props: any,
  pixelX: number,
  pixelY: number
): { channelIndex: number; labelId: number; selection?: unknown } | null {
  const {
    channelData,
    channelsVisible,
    selections,
    channelColors,
    channelOpacities,
    channelOutlineOpacities,
    channelsFilled,
    channelStrokeWidths,
  } = props;
  const channelArrays = channelData?.data;
  const width = channelData?.width;
  const height = channelData?.height;
  if (!channelArrays?.length || !width || !height) {
    return null;
  }

  const actualChannelCount = Math.max(
    1,
    Math.min(
      MAX_LABEL_CHANNELS,
      channelArrays.length ??
        selections?.length ??
        channelColors?.length ??
        channelsVisible?.length ??
        channelOpacities?.length ??
        channelOutlineOpacities?.length ??
        channelsFilled?.length ??
        channelStrokeWidths?.length ??
        1
    )
  );
  const pixelIndex = pixelY * width + pixelX;
  for (let channelIndex = actualChannelCount - 1; channelIndex >= 0; channelIndex--) {
    if (!(channelsVisible?.[channelIndex] ?? true)) {
      continue;
    }
    const labelValue = Number(channelArrays[channelIndex]?.[pixelIndex] ?? 0);
    if (Number.isFinite(labelValue) && labelValue > 0) {
      return {
        channelIndex,
        labelId: labelValue,
        selection: selections?.[channelIndex],
      };
    }
  }
  return null;
}

type LabelsBitmaskTileLayerProps = {
  channelColors?: Array<[number, number, number]>;
  channelsFilled?: boolean[];
  channelOpacities?: number[];
  channelOutlineOpacities?: number[];
  channelsVisible?: boolean[];
  channelStrokeWidths?: number[];
  maxZoom?: number;
  opacity?: number;
  zoom?: number;
};

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

  constructor(...args: any[]) {
    super(...args);
  }

  getShaders(): any {
    return {
      fs,
      vs,
      modules: [project32, picking, labelsBitmaskUniforms],
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
    const pickedLabel = getTopmostLabelAtPixel(this.props, pixelX, pixelY);
    if (!pickedLabel) {
      info.object = null;
      return info;
    }

    info.object = {
      ...pickedLabel,
      pixel: [pixelX, pixelY] as const,
    };
    info.index = pickedLabel.channelIndex;
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

  // Override the parent implementation to support up to seven label channels.
  loadChannelTextures(channelData: { data?: unknown[]; width: number; height: number }) {
    const textures: Record<string, unknown> = {
      channel0: null,
      channel1: null,
      channel2: null,
      channel3: null,
      channel4: null,
      channel5: null,
      channel6: null,
    };

    if (this.state.textures) {
      Object.values(this.state.textures as Record<string, { delete?: () => void } | null>).forEach(
        (tex) => {
          tex?.delete?.();
        }
      );
    }

    if (channelData?.data?.length) {
      channelData.data.forEach((data, index) => {
        if (index >= MAX_LABEL_CHANNELS) {
          return;
        }
        textures[`channel${index}`] = this.dataToTexture(
          data,
          channelData.width,
          channelData.height
        );
      });
      for (const key of Object.keys(textures)) {
        if (!textures.channel0) {
          throw new Error('Bad labels texture state.');
        }
        if (!textures[key]) {
          textures[key] = textures.channel0;
        }
      }
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
      channelData,
      selections,
    } = this.props;

    const actualChannelCount = Math.max(
      1,
      Math.min(
        MAX_LABEL_CHANNELS,
        channelData?.data?.length ??
          selections?.length ??
          channelColors?.length ??
          channelsVisible?.length ??
          channelOpacities?.length ??
          channelOutlineOpacities?.length ??
          channelsFilled?.length ??
          channelStrokeWidths?.length ??
          1
      )
    );

    const normalizedColors = Array.from({ length: MAX_LABEL_CHANNELS }, (_, index) =>
      getNormalizedColor(
        index < actualChannelCount ? (channelColors?.[index] ?? [255, 255, 255]) : [255, 255, 255]
      )
    );

    const zoomDelta = typeof zoom === 'number' && typeof maxZoom === 'number' ? maxZoom - zoom : 0;
    const scaleFactor = 1 / 2 ** zoomDelta;

    const filled = Array.from({ length: MAX_LABEL_CHANNELS }, (_, index) =>
      index < actualChannelCount ? (channelsFilled?.[index] ?? true) : false
    );
    const opacities = Array.from({ length: MAX_LABEL_CHANNELS }, (_, index) =>
      index < actualChannelCount ? (channelOpacities?.[index] ?? 0.18) : 0
    );
    const outlineOpacities = Array.from({ length: MAX_LABEL_CHANNELS }, (_, index) =>
      index < actualChannelCount ? (channelOutlineOpacities?.[index] ?? 0.95) : 0
    );
    const visible = Array.from({ length: MAX_LABEL_CHANNELS }, (_, index) =>
      index < actualChannelCount ? (channelsVisible?.[index] ?? true) : false
    );
    const strokeWidths = Array.from({ length: MAX_LABEL_CHANNELS }, (_, index) =>
      index < actualChannelCount ? (channelStrokeWidths?.[index] ?? 1.5) : 1
    );

    const labelsBitmask = Object.fromEntries([
      ...normalizedColors.map((color, index) => [`color${index}`, [...color, 1] as const]),
      ...filled.map((value, index) => [`channelFilled${index}`, value ? 1 : 0]),
      ...opacities.map((value, index) => [`channelOpacity${index}`, value]),
      ...outlineOpacities.map((value, index) => [`channelOutlineOpacity${index}`, value]),
      ...visible.map((value, index) => [`channelVisible${index}`, value ? 1 : 0]),
      ...strokeWidths.map((value, index) => [`channelStrokeWidth${index}`, value]),
      ['scaleFactor', scaleFactor],
      ['labelOpacity', opacity],
    ]);

    model.shaderInputs?.setProps({ labelsBitmask });
    model.setBindings(textures);
    model.draw((this.context as { renderPass?: unknown }).renderPass);
  }
}
