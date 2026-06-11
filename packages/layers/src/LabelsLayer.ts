import { getImageSize } from '@hms-dbmi/viv';
import type { Matrix4 } from '@math.gl/core';
import {
  CompositeLayer,
  type CompositeLayerProps,
  type Layer,
  type LayersList,
  TileLayer,
} from 'deck.gl';
import { LabelsBitmaskTileLayer } from './LabelsBitmaskTileLayer';

/** One instance-ID raster per labels element (see `LabelsBitmaskTileLayer`). */
export const MAX_LABEL_CHANNELS = 1 as const;
const MIN_LABELS_DISPLAY_ZOOM = -20;

export type LabelsSelection = Partial<{ z: number; c: number; t: number }>;

function firstSelection(selections: LabelsSelection[] | undefined): LabelsSelection {
  return selections?.[0] ?? {};
}

function selectionKey(selection: LabelsSelection): string {
  return `z:${selection.z ?? ''}|c:${selection.c ?? ''}|t:${selection.t ?? ''}`;
}

function labelsSelectionKey(selections: LabelsSelection[] | undefined): string {
  return selectionKey(firstSelection(selections));
}

function stylePlane<T>(arr: T[] | undefined, fallback: T): [T] {
  return [arr?.[0] ?? fallback];
}

export interface LabelsLayerProps {
  id: string;
  loader: unknown;
  /** Only the first entry is used (one Z/C/T plane of instance IDs). */
  selections: LabelsSelection[];
  visible?: boolean;
  opacity?: number;
  modelMatrix?: Matrix4;
  channelColors?: Array<[number, number, number]>;
  channelsVisible?: boolean[];
  channelOpacities?: number[];
  channelOutlineOpacities?: number[];
  channelsFilled?: boolean[];
  channelStrokeWidths?: number[];
  onClick?: (info: unknown) => void;
  onHover?: (info: unknown) => void;
  _subLayerProps?: CompositeLayerProps['_subLayerProps'];
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
    const selectionsChanged = props.labelsSelectionKey !== oldProps.labelsSelectionKey;

    if (!loaderChanged && !selectionsChanged) {
      return;
    }

    (this.state.abortController as AbortController | undefined)?.abort();
    const abortController = new AbortController();
    this.setState({ abortController });

    const { signal } = abortController;
    const selection = firstSelection(props.selections);
    const getRaster = (props.loader as any).getRaster.bind(props.loader);

    getRaster({ selection, signal })
      .then((raster0: { data: unknown; width: number; height: number }) => {
        if (signal.aborted) {
          return;
        }
        const raster = {
          data: [raster0.data],
          width: raster0.width,
          height: raster0.height,
        };
        if (typeof props.onViewportLoad === 'function') {
          props.onViewportLoad(raster);
        }
        this.setState(raster);
      })
      .catch((error: unknown) => {
        if (signal.aborted || (error as { name?: string } | null)?.name === 'AbortError') {
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
      channelColors: channelColorsProp,
      channelsVisible: channelsVisibleProp,
      channelOpacities: channelOpacitiesProp,
      channelOutlineOpacities: channelOutlineOpacitiesProp,
      channelsFilled: channelsFilledProp,
      channelStrokeWidths: channelStrokeWidthsProp,
      selections: selectionsProp,
    } = this.props;
    const selections = [firstSelection(selectionsProp)];
    const channelColors = stylePlane(channelColorsProp, [255, 255, 255]);
    const channelsVisible = stylePlane(channelsVisibleProp, true);
    const channelOpacities = stylePlane(channelOpacitiesProp, 0.18);
    const channelOutlineOpacities = stylePlane(channelOutlineOpacitiesProp, 0.95);
    const channelsFilled = stylePlane(channelsFilledProp, true);
    const channelStrokeWidths = stylePlane(channelStrokeWidthsProp, 1.5);
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
        pickable: true,
        ...(typeof onClick === 'function' ? { onClick } : {}),
        ...(typeof onHover === 'function' ? { onHover } : {}),
      }),
      {
        channelData: { data, height, width },
        channelColors,
        channelsVisible,
        channelOpacities,
        channelOutlineOpacities,
        channelsFilled,
        channelStrokeWidths,
        selections,
        bounds,
        id: `image-sub-layer-${bounds}-${id}`,
        interpolation: 'nearest',
        maxZoom: 0,
        minZoom: MIN_LABELS_DISPLAY_ZOOM,
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

  // biome-ignore lint/complexity/noUselessConstructor: TileLayer's public types reject the Viv-style constructor overload used here.
  constructor(...args: any[]) {
    super(...args);
  }

  async getTileData({
    index: { x, y, z },
    signal,
  }: {
    index: { x: number; y: number; z: number };
    signal: AbortSignal;
  }) {
    const loader = this.props.loader;
    const loaders = Array.isArray(loader) ? loader : [loader];
    const resolution = Math.max(0, Math.min(loaders.length - 1, Math.round(-z)));
    const selection = firstSelection(this.props.selections);
    const tileLoader = loaders[resolution] as any;
    const getTile = tileLoader?.getTile?.bind(tileLoader);

    if (!getTile) {
      return null;
    }

    try {
      const tile = await getTile({ x, y, selection, signal });
      if (!tile) {
        return null;
      }
      return {
        data: [tile.data],
        width: tile.width,
        height: tile.height,
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
  }

  _updateTileset(): void {
    if (!this.props.viewportId) {
      super._updateTileset();
      return;
    }
    if (this.context.viewport.id === this.props.viewportId || !this.state.tileset?._viewport) {
      super._updateTileset();
    }
  }
}

function renderSubBitmaskLayers(props: any) {
  const {
    bbox: { left, top, right, bottom },
    index: { x, y, z },
    zoom,
  } = props.tile;
  const { data, id, loader, maxZoom, minZoom, zoomOffset } = props;

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
    id: `sub-layer-${z}-${x}-${y}-${bounds}-${id}`,
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
    channelOpacities: [0.18],
    channelOutlineOpacities: [0.95],
    channelsFilled: [true],
    channelStrokeWidths: [1.5],
  } satisfies Partial<LabelsLayerProps>;

  renderLayers(): Layer | null | LayersList {
    const {
      loader,
      selections: selectionsProp,
      visible = true,
      opacity = 1,
      modelMatrix,
      channelColors = [[255, 255, 255]],
      channelsVisible = [true],
      channelOpacities = [0.18],
      channelOutlineOpacities = [0.95],
      channelsFilled = [true],
      channelStrokeWidths = [1.5],
      onClick,
      onHover,
    } = this.props;

    if (!visible || !loader) {
      return null;
    }

    const selections = [firstSelection(selectionsProp)];
    const structuralSelectionKey = labelsSelectionKey(selections);
    const nextLoader = Array.isArray(loader) && loader.length === 1 ? loader[0] : loader;
    const commonProps = {
      loader: nextLoader,
      selections,
      labelsSelectionKey: structuralSelectionKey,
      modelMatrix,
      opacity,
      channelsVisible: stylePlane(channelsVisible, true),
      channelColors: stylePlane(channelColors, [255, 255, 255]),
      channelOpacities: stylePlane(channelOpacities, 0.18),
      channelOutlineOpacities: stylePlane(channelOutlineOpacities, 0.95),
      channelsFilled: stylePlane(channelsFilled, true),
      channelStrokeWidths: stylePlane(channelStrokeWidths, 1.5),
    } as const;
    const interactionProps = {
      ...(typeof onClick === 'function' ? { onClick } : {}),
      ...(typeof onHover === 'function' ? { onHover } : {}),
    };

    if (isMultiscaleLoader(loader)) {
      const baseLoader = loader[0] as any;
      const { height, width } = getImageSize(baseLoader);
      const tileSize = baseLoader.tileSize;
      const zoomOffset = Math.round(Math.log2(modelMatrix ? modelMatrix.getScale()[0] : 1));

      return new MultiscaleLabelsTileLayer(
        this.getSubLayerProps({
          id: 'labels',
          pickable: true,
          visible,
          updateTriggers: {
            getTileData: [nextLoader, structuralSelectionKey],
          },
        }),
        {
          ...commonProps,
          ...interactionProps,
          tileSize,
          extent: [0, 0, width, height],
          zoomOffset,
          minZoom: MIN_LABELS_DISPLAY_ZOOM,
          maxZoom: 0,
          refinementStrategy: 'best-available',
          onTileError: baseLoader.onTileError,
          renderSubLayers: renderSubBitmaskLayers,
        } as any
      ) as unknown as Layer;
    }

    return new SingleScaleLabelsLayer(
      this.getSubLayerProps({
        id: 'labels',
        pickable: true,
        visible,
      }),
      {
        ...commonProps,
        ...interactionProps,
      } as any
    ) as unknown as Layer;
  }
}
