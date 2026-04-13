import type { Matrix4 } from '@math.gl/core';
import { getImageSize } from '@hms-dbmi/viv';
import { CompositeLayer, TileLayer, type Layer, type LayersList } from 'deck.gl';
import { LabelsBitmaskTileLayer } from './LabelsBitmaskTileLayer';

export const MAX_LABEL_CHANNELS = 7 as const;

export type LabelsSelection = Partial<{ z: number; c: number; t: number }>;

export interface LabelsLayerProps {
  id: string;
  loader: unknown;
  selections: LabelsSelection[];
  visible?: boolean;
  opacity?: number;
  modelMatrix?: Matrix4;
  channelColors?: Array<[number, number, number]>;
  channelsVisible?: boolean[];
  channelOpacities?: number[];
  channelsFilled?: boolean[];
  channelStrokeWidths?: number[];
  onClick?: (info: unknown) => void;
  onHover?: (info: unknown) => void;
}

const VIV_SIGNAL_ABORTED = '__vivSignalAborted';
const UntypedTileLayer = TileLayer as any;

function isMultiscaleLoader(loader: unknown): loader is unknown[] {
  return Array.isArray(loader) && loader.length > 1;
}

function getBaseLoader(loader: any) {
  return Array.isArray(loader) ? loader[0] : loader;
}

class SingleScaleLabelsLayer extends CompositeLayer<any> {
  static layerName = 'SingleScaleLabelsLayer';

  finalizeState(context: any): void {
    (this.state.abortController as AbortController | undefined)?.abort();
    super.finalizeState(context);
  }

  updateState({ props, oldProps }: { props: any; oldProps: any }): void {
    const loaderChanged = props.loader !== oldProps.loader;
    const selectionsChanged = props.selections !== oldProps.selections;

    if (!loaderChanged && !selectionsChanged) {
      return;
    }

    (this.state.abortController as AbortController | undefined)?.abort();
    const abortController = new AbortController();
    this.setState({ abortController });

    const { signal } = abortController;
    const getRaster = (selection: any) => props.loader.getRaster({ selection, signal });
    const dataPromises = (props.selections ?? []).map(getRaster);

    Promise.all(dataPromises)
      .then((rasters) => {
        if (signal.aborted) {
          return;
        }
        const raster = {
          data: rasters.map((rasterData) => rasterData.data),
          width: rasters[0]?.width,
          height: rasters[0]?.height,
        };
        if (typeof props.onViewportLoad === 'function') {
          props.onViewportLoad(raster);
        }
        this.setState(raster);
      })
      .catch((error) => {
        if (signal.aborted || error?.name === 'AbortError') {
          return;
        }
        throw error;
      });
  }

  renderLayers(): Layer | null {
    const {
      id,
      onClick,
      onHover,
      channelColors,
      channelsVisible,
      channelOpacities,
      channelsFilled,
      channelStrokeWidths,
      selections,
    } = this.props;
    const { width, height, data } = this.state as {
      width?: number;
      height?: number;
      data?: unknown[];
    };

    if (!(width && height) || !data) {
      return null;
    }

    const bounds = [0, height, width, 0] as const;

    return new LabelsBitmaskTileLayer(
      this.getSubLayerProps({
        id: 'single-scale-labels-bitmask',
        pickable: false,
        ...(typeof onClick === 'function' ? { onClick } : {}),
        ...(typeof onHover === 'function' ? { onHover } : {}),
      }),
      {
        channelData: { data, height, width },
        channelColors,
        channelsVisible,
        channelOpacities,
        channelsFilled,
        channelStrokeWidths,
        selections,
        bounds,
        id: `image-sub-layer-${bounds}-${id}`,
        interpolation: 'nearest',
        maxZoom: 0,
        minZoom: 0,
        zoom: 0,
      }
    ) as unknown as Layer;
  }
}

// Temporary Viv workaround: current Viv ImageLayer/MultiscaleImageLayer prop schemas
// reject null callback defaults and mis-type interpolation, which breaks labels paths
// that otherwise mirror Viv. Replace these local wrappers once the upstream fixes land.
class MultiscaleLabelsTileLayer extends UntypedTileLayer {
  static layerName = 'MultiscaleLabelsTileLayer';

  constructor(...args: any[]) {
    super(...args);
  }

  _updateTileset(): void {
    if (!this.props.viewportId) {
      super._updateTileset();
      return;
    }
    if (
      this.context.viewport.id === this.props.viewportId ||
      !this.state.tileset?._viewport
    ) {
      super._updateTileset();
    }
  }
}

function renderSubBitmaskLayers(props: any) {
  const {
    bbox: {
      left, top, right, bottom,
    },
    index: { x, y, z },
    zoom,
  } = props.tile;
  const {
    data, id, loader, maxZoom, minZoom, zoomOffset,
  } = props;

  if (!data) {
    return null;
  }

  const base = getBaseLoader(loader);
  if (!base?.shape) {
    return null;
  }
  const [height, width] = base.shape.slice(-2);
  const bounds = [
    left,
    data.height < base.tileSize ? height : bottom,
    data.width < base.tileSize ? width : right,
    top,
  ];

  return new LabelsBitmaskTileLayer(props, {
    channelData: data,
    bounds,
    id: `sub-layer-${bounds}-${id}`,
    tileId: { x, y, z },
    zoom,
    minZoom,
    maxZoom,
    zoomOffset,
  }) as unknown as Layer;
}

export class LabelsLayer extends CompositeLayer<LabelsLayerProps> {
  static layerName = 'LabelsLayer';

  static defaultProps = {
    opacity: 1,
    visible: true,
    selections: [{}],
    channelColors: [[255, 255, 255]],
    channelsVisible: [true],
    channelOpacities: [0.35],
    channelsFilled: [true],
    channelStrokeWidths: [2],
  } satisfies Partial<LabelsLayerProps>;

  renderLayers(): Layer | null | LayersList {
    const {
      loader,
      selections,
      visible = true,
      opacity = 1,
      modelMatrix,
      channelColors = [[255, 255, 255]],
      channelsVisible = [true],
      channelOpacities = [0.35],
      channelsFilled = [true],
      channelStrokeWidths = [2],
      onClick,
      onHover,
    } = this.props;

    if (!visible || !loader) {
      return null;
    }

    const nextLoader = Array.isArray(loader) && loader.length === 1 ? loader[0] : loader;
    const commonProps = {
      loader: nextLoader,
      selections,
      modelMatrix,
      opacity,
      channelsVisible,
      channelColors,
      channelOpacities,
      channelsFilled,
      channelStrokeWidths,
    } as const;
    const interactionProps = {
      ...(typeof onClick === 'function' ? { onClick } : {}),
      ...(typeof onHover === 'function' ? { onHover } : {}),
    };

    if (isMultiscaleLoader(loader)) {
      const baseLoader = loader[0] as any;
      const { height, width } = getImageSize(baseLoader);
      const tileSize = baseLoader.tileSize;
      const zoomOffset = Math.round(
        Math.log2(modelMatrix ? modelMatrix.getScale()[0] : 1)
      );
      const getTileData = async ({
        index: { x, y, z },
        signal,
      }: {
        index: { x: number; y: number; z: number };
        signal: AbortSignal;
      }) => {
        if (!selections || selections.length === 0) {
          return null;
        }

        const resolution = Math.max(0, Math.min(loader.length - 1, Math.round(-z)));
        const getTile = (selection: LabelsSelection) =>
          (loader[resolution] as any).getTile({ x, y, selection, signal });

        try {
          const tiles = await Promise.all(selections.map(getTile));
          return {
            data: tiles.map((tile) => tile.data),
            width: tiles[0]?.width,
            height: tiles[0]?.height,
          };
        } catch (error) {
          if (
            error === VIV_SIGNAL_ABORTED ||
            signal.aborted ||
            (error as { name?: string } | null)?.name === 'AbortError'
          ) {
            return null;
          }
          throw error;
        }
      };

      return new MultiscaleLabelsTileLayer(
        this.getSubLayerProps({
          id: 'labels',
          pickable: false,
          visible,
        }),
        {
          ...commonProps,
          ...interactionProps,
          getTileData,
          tileSize,
          extent: [0, 0, width, height],
          zoomOffset,
          minZoom: Math.round(-(loader.length - 1)),
          maxZoom: 0,
          refinementStrategy: opacity === 1 ? 'best-available' : 'no-overlap',
          onTileError: baseLoader.onTileError,
          renderSubLayers: renderSubBitmaskLayers,
        } as any
      ) as unknown as Layer;
    }

    return new SingleScaleLabelsLayer(
      this.getSubLayerProps({
        id: 'labels',
        pickable: false,
        visible,
      }),
      {
        ...commonProps,
        ...interactionProps,
      } as any
    ) as unknown as Layer;
  }
}
