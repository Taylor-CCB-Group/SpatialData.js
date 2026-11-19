import type { Layer, PickingInfo } from '@deck.gl/core';
import { ScaleBarLayer } from '@hms-dbmi/viv';
import { DeviceAdaptiveImageLayer } from '@spatialdata/layers';
import { DetailView } from '@vivjs/views';
import type { ImageLayerConfig } from './useLayerData';

/** The token Viv puts in a layer id to say which view draws it. */
export function getVivId(viewId: string): string {
  return `-#${viewId}#`;
}

export interface VivImageLayersOptions {
  /**
   * Every layer id carries `getVivId(viewId)`, for a host `layerFilter` to route by:
   * a view's id, or a token shared by several views.
   */
  viewId: string;
  /**
   * The view whose viewport selects a tiled image's tiles (Viv's `viewportId`). Unset,
   * tiles follow whichever view draws the image: right for one set drawn in several
   * views under one view state, as in a grid. Set it to a view's id when other views,
   * with other view states, would otherwise move the tiles.
   */
  viewportId?: string;
  onHover?: (info: PickingInfo) => void;
}

function isLayerLike(value: unknown): value is Layer {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const id = Reflect.get(value, 'id');
  const clone = Reflect.get(value, 'clone');
  return typeof id === 'string' && typeof clone === 'function';
}

export function normalizeVivLayers(raw: unknown): Layer[] {
  if (isLayerLike(raw)) {
    return [raw];
  }
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw.flatMap((entry) => normalizeVivLayers(entry));
}

function vivLayerProps(
  config: ImageLayerConfig,
  onHover: VivImageLayersOptions['onHover']
): Record<string, unknown> {
  const props: Record<string, unknown> = {
    loader: config.loader,
    colors: config.colors,
    contrastLimits: config.contrastLimits,
    channelsVisible: config.channelsVisible,
    selections: config.selections,
    onHover,
  };
  // Let Viv/deck merge these with layer defaultProps (including `extensions`).
  // Do not patch `layer.props` afterward with `{ ...layer.props, opacity }` — that spread
  // drops non-enumerable props like `extensions` and breaks MultiscaleImageLayer._update.
  if (config.opacity !== undefined) {
    props.opacity = config.opacity;
  }
  if (config.visible !== undefined) {
    props.visible = config.visible;
  }
  if (config.modelMatrix) {
    props.modelMatrix = config.modelMatrix;
  }
  if (config.alphaFromIntensity) {
    props.alphaFromIntensity = config.alphaFromIntensity;
  }
  if (config.vivProps) {
    Object.assign(props, config.vivProps);
  }
  return props;
}

/**
 * Deck layers for Viv image configs, as `VivSpatialViewer` draws them, for hosts that
 * build their own `Deck` (for example one view per grid cell). Keyed by config id, in
 * config order, so the result can go straight into `renderStackToDeckLayers`'
 * `entryLayers`. Each layer works on WebGL and WebGPU.
 */
export function vivImageLayers(
  configs: readonly ImageLayerConfig[],
  { viewId, viewportId = '', onHover }: VivImageLayersOptions
): Map<string, Layer[]> {
  // getLayers reads only the view id; the size matters only to Viv's own views.
  const detailView = new DetailView({ id: viewId, width: 0, height: 0 });
  const result = new Map<string, Layer[]>();
  for (const config of configs) {
    const layers = result.get(config.id) ?? [];
    for (const layer of normalizeVivLayers(
      detailView.getLayers({ props: vivLayerProps(config, onHover) })
    )) {
      // The scale bar measures the view, not an image.
      if (layer instanceof ScaleBarLayer) {
        continue;
      }
      // Viv's ids name the source class and view, so overlays need a per-image suffix.
      // `DetailView` sets `viewportId` to the view token, which may name no view.
      const overrides = { id: `${layer.id}-${config.id}`, viewportId };
      const vivLayer = layer.clone(overrides);
      // Swaps Viv's GLSL tiles for WGSL ones when deck is on WebGPU.
      layers.push(new DeviceAdaptiveImageLayer({ id: `${vivLayer.id}-device`, vivLayer }));
    }
    result.set(config.id, layers);
  }
  return result;
}
