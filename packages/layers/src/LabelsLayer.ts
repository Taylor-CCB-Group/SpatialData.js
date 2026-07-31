import { getImageSize } from '@hms-dbmi/viv';
import type { Texture } from '@luma.gl/core';
import type { Matrix4 } from '@math.gl/core';
import {
  CompositeLayer,
  type CompositeLayerProps,
  type Layer,
  type LayersList,
  TileLayer,
  type UpdateParameters,
} from 'deck.gl';
import { LabelsBitmaskTileLayer } from './LabelsBitmaskTileLayer';
import {
  buildLabelColorLut,
  DEFAULT_LABEL_HIGHLIGHT_COLOR,
  LABEL_COLOR_LUT_WIDTH,
  type LabelColorLut,
  type LabelFeatureStateInput,
  type LabelRgbaColor,
  type LabelRgbColor,
  NO_HIGHLIGHTED_LABEL,
} from './labelColorEncoding';

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
  /**
   * Per-label filtering and colouring, with the same field names and the same
   * meanings as a shapes layer's feature-state. A labels feature id is the label's
   * integer instance id as a string.
   *
   * Ignored when {@link featureColorLut} is supplied.
   */
  featureState?: LabelFeatureStateInput;
  /**
   * A pre-built lookup table, for callers that already cache one keyed by their own
   * feature-state signature (the projection path). Skips the O(max-label-id) build
   * that {@link featureState} would otherwise do inside the layer.
   */
  featureColorLut?: LabelColorLut;
  /**
   * The label id under the cursor, or `-1` / omitted for none.
   *
   * Runtime render state, not config: it changes on every pointer move and must
   * never be serialized into a saved view. It reaches the shader as a uniform, so
   * hovering re-uploads nothing — the LUT and the tiles are both untouched.
   */
  highlightedLabelId?: number | null;
  /**
   * Hover tint, RGBA 0–255; defaults to {@link DEFAULT_LABEL_HIGHLIGHT_COLOR}.
   *
   * Deliberately deck's own `Layer` prop name, and deliberately the same meaning:
   * deck blends its `highlightColor` over a highlighted fragment weighted by that
   * colour's alpha, which is exactly what the labels shader does. One name across
   * shapes (via `autoHighlight`) and labels. The labels default is declared in
   * `defaultProps`, which is what overrides deck's navy base default.
   *
   * Unlike deck's, this one must be an array — the accessor/function form has no
   * meaning here, since there is no per-label deck object to call it with.
   */
  highlightColor?: LabelRgbaColor;
  onClick?: (info: unknown) => void;
  onHover?: (info: unknown) => void;
  _subLayerProps?: CompositeLayerProps['_subLayerProps'];
}

/**
 * Memoised `featureState → LUT`, so a bare re-render (a hover, a pan) does not
 * rebuild a table that can be megabytes. Keyed by the feature-state's identity and
 * then by the default colour, which is baked into every unannotated entry — the
 * same two-level discipline `getFeatureColors` uses for shapes.
 */
const lutCache = new WeakMap<object, Map<string, LabelColorLut | null>>();

function resolveFeatureColorLut(
  featureState: LabelFeatureStateInput | undefined,
  defaultColor: LabelRgbColor
): LabelColorLut | undefined {
  if (!featureState) return undefined;
  const colorKey = `${defaultColor[0]},${defaultColor[1]},${defaultColor[2]}`;
  let byColor = lutCache.get(featureState);
  if (!byColor) {
    byColor = new Map();
    lutCache.set(featureState, byColor);
  }
  const cached = byColor.get(colorKey);
  // `null` is a cached "this feature-state addresses nothing", distinct from a miss.
  if (cached !== undefined) return cached ?? undefined;
  const built = buildLabelColorLut({ featureState, defaultColor }) ?? null;
  byColor.set(colorKey, built);
  return built ?? undefined;
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
      featureColorLut,
      featureColorTexture,
      highlightedLabelId,
      highlightColor,
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
        featureColorLut,
        featureColorTexture,
        highlightedLabelId: highlightedLabelId ?? NO_HIGHLIGHTED_LABEL,
        highlightColor,
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

  // Cull tiles that fall outside the image extent. deck.gl's TileLayer emits
  // tiles with negative bbox edges at some zoom levels (notably zoomed-out /
  // overview levels for non-power-of-2 images); feeding those negative edges
  // into the bounds formula below produces a grossly mis-placed/stretched
  // raster. Mirrors Viv's own renderSubLayers guard.
  if ([left, bottom, right, top].some((v) => v < 0) || !data) {
    return null;
  }
  if (data.width === 0 || data.height === 0) {
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
    // Overrides deck's own `Layer` default for this prop (navy `[0, 0, 128, 128]`).
    // The default MUST be declared here rather than applied with `?? DEFAULT` at the
    // use site: deck fills its base default in, so the prop is never absent and a
    // use-site fallback can never run.
    highlightColor: DEFAULT_LABEL_HIGHLIGHT_COLOR,
  } satisfies Partial<LabelsLayerProps>;

  /**
   * The LUT in force for this render: an explicitly supplied one, else one built
   * (and memoised) from `featureState`. Pure — safe to call from `renderLayers`.
   */
  _resolveFeatureColorLut(): LabelColorLut | undefined {
    const { featureColorLut, featureState, channelColors } = this.props;
    const defaultColor: LabelRgbColor = channelColors?.[0] ?? [255, 255, 255];
    return featureColorLut ?? resolveFeatureColorLut(featureState, defaultColor);
  }

  updateState(params: UpdateParameters<CompositeLayer<LabelsLayerProps>>): void {
    super.updateState(params);
    this._updateFeatureColorTexture();
  }

  /**
   * Keep the LUT's GPU texture in step with the resolved table.
   *
   * The texture lives here, on the composite, rather than on the bitmask sublayers:
   * a tiled labels element draws many sublayers at once and they all read the same
   * table, so one upload is both correct and the difference between a few megabytes
   * and a few tens of megabytes.
   */
  _updateFeatureColorTexture(): void {
    const lut = this._resolveFeatureColorLut();

    if (this.state?.featureColorLut === lut) {
      return;
    }

    this._destroyFeatureColorTexture();
    let texture: Texture | null = null;
    if (lut) {
      const height = Math.max(1, Math.ceil(lut.count / LABEL_COLOR_LUT_WIDTH));
      // Pad to the full texel grid: the shader addresses by row/column, so the tail
      // of the last row must exist even though no label maps to it.
      const data = new Uint8Array(LABEL_COLOR_LUT_WIDTH * height * 4);
      data.set(lut.colors.subarray(0, Math.min(lut.colors.length, data.length)));
      texture = this.context.device.createTexture({
        width: LABEL_COLOR_LUT_WIDTH,
        height,
        dimension: '2d',
        data,
        sampler: { minFilter: 'nearest', magFilter: 'nearest' },
        format: 'rgba8unorm',
      });
    }
    this.setState({ featureColorLut: lut, featureColorTexture: texture });
  }

  /**
   * Release the LUT texture.
   *
   * `destroy()` unconditionally, not `destroy?.()`: luma's `Texture` declares it,
   * so an optional call could only ever hide a wrong type — and what it would hide
   * is a leaked GPU texture that nothing reports. (`delete()` is the luma 8
   * spelling, deprecated in 9.)
   */
  _destroyFeatureColorTexture(): void {
    const texture = this.state?.featureColorTexture as Texture | null | undefined;
    texture?.destroy();
  }

  finalizeState(context: unknown): void {
    this._destroyFeatureColorTexture();
    // biome-ignore lint/suspicious/noExplicitAny: CompositeLayer's finalizeState is optional in its public types.
    (super.finalizeState as any)?.(context);
  }

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
      highlightedLabelId,
      highlightColor,
      onClick,
      onHover,
    } = this.props;

    if (!visible || !loader) {
      return null;
    }

    const selections = [firstSelection(selectionsProp)];
    const structuralSelectionKey = labelsSelectionKey(selections);
    const nextLoader = Array.isArray(loader) && loader.length === 1 ? loader[0] : loader;
    // The LUT is resolved here (memoised, pure) rather than read from state so the
    // sublayers see it even on a render that precedes the texture upload; the
    // texture comes from state, and the shader only samples when it has both.
    const featureColorLut = this._resolveFeatureColorLut();
    const commonProps = {
      loader: nextLoader,
      selections,
      labelsSelectionKey: structuralSelectionKey,
      modelMatrix,
      opacity,
      featureColorLut,
      featureColorTexture: this.state?.featureColorTexture ?? null,
      highlightedLabelId: highlightedLabelId ?? NO_HIGHLIGHTED_LABEL,
      highlightColor,
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
      // Cap the coarsest tile zoom at the deepest available resolution level
      // (matches Viv's MultiscaleImageLayer). Without this, deck.gl keeps
      // subdividing past the last real level when zoomed out: getTileData
      // clamps to the deepest loader and returns the same data, but the tile
      // bbox keeps doubling, so the bounds formula stretches that data far
      // beyond the image extent — the "wrong transformation" at low zoom.
      const minZoom = Math.round(-(loader.length - 1));

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
          minZoom,
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
