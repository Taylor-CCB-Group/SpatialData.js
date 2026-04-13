import { project32, picking } from '@deck.gl/core';
import { XRLayer } from '@hms-dbmi/viv';
import { fs, labelsBitmaskUniforms, vs } from './labelsBitmaskLayerShaders';

const MAX_LABEL_CHANNELS = 7;

function padWithDefault<T>(arr: readonly T[] | undefined, defaultValue: T, targetLength: number): T[] {
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

type LabelsBitmaskTileLayerProps = {
  channelColors?: Array<[number, number, number]>;
  channelsFilled?: boolean[];
  channelOpacities?: number[];
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
    channelOpacities: { type: 'array', value: [0.35], compare: true },
    channelsVisible: { type: 'array', value: [true], compare: true },
    channelStrokeWidths: { type: 'array', value: [2], compare: true },
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
      Object.values(
        this.state.textures as Record<string, { delete?: () => void } | null>
      ).forEach((tex) => {
        tex?.delete?.();
      });
    }

    if (channelData?.data?.length) {
      channelData.data.forEach((data, index) => {
        if (index >= MAX_LABEL_CHANNELS) {
          return;
        }
        textures[`channel${index}`] = this.dataToTexture(data, channelData.width, channelData.height);
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
          channelsFilled?.length ??
          channelStrokeWidths?.length ??
          1
      )
    );

    const normalizedColors = Array.from({ length: MAX_LABEL_CHANNELS }, (_, index) =>
      getNormalizedColor(
        index < actualChannelCount ? channelColors?.[index] ?? [255, 255, 255] : [255, 255, 255]
      )
    );

    const zoomDelta =
      typeof zoom === 'number' && typeof maxZoom === 'number' ? maxZoom - zoom : 0;
    const scaleFactor = 1 / (2 ** zoomDelta);

    const filled = Array.from(
      { length: MAX_LABEL_CHANNELS },
      (_, index) => (index < actualChannelCount ? channelsFilled?.[index] ?? true : false)
    );
    const opacities = Array.from(
      { length: MAX_LABEL_CHANNELS },
      (_, index) => (index < actualChannelCount ? channelOpacities?.[index] ?? 0.35 : 0)
    );
    const visible = Array.from(
      { length: MAX_LABEL_CHANNELS },
      (_, index) => (index < actualChannelCount ? channelsVisible?.[index] ?? true : false)
    );
    const strokeWidths = Array.from(
      { length: MAX_LABEL_CHANNELS },
      (_, index) => (index < actualChannelCount ? channelStrokeWidths?.[index] ?? 2 : 1)
    );

    const labelsBitmask = Object.fromEntries([
      ...normalizedColors.map((color, index) => [`color${index}`, [...color, 1] as const]),
      ...filled.map((value, index) => [`channelFilled${index}`, value ? 1 : 0]),
      ...opacities.map((value, index) => [`channelOpacity${index}`, value]),
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
