import type { Matrix4 } from '@math.gl/core';
import type { UpdateParameters } from '@deck.gl/core';
import { CompositeLayer } from 'deck.gl';
import type { Layer, LayersList } from 'deck.gl';
import type { PointsRenderResource } from './pointsLoader.js';
import type { PointsTileLoadCallbacks } from './pointsTileLoadCallbacks.js';
import type { TileDebugStore } from './pointsTiledDebugHooks.js';
import type { ColumnarNdarrayPointsBatch } from './pointsLoader.js';
import { resolvePointsRenderStrategy } from './pointsRenderStrategies.js';
import {
  DEFAULT_POINT_RADIUS_MAX_PIXELS,
  DEFAULT_POINT_RADIUS_MIN_PIXELS,
  DEFAULT_POINT_SIZE,
} from './pointsScatterLayer.js';

export interface PointsLayerProps {
  id: string;
  resource: PointsRenderResource;
  visible?: boolean;
  opacity?: number;
  modelMatrix: Matrix4;
  pointSize?: number;
  pointRadiusMinPixels?: number;
  pointRadiusMaxPixels?: number;
  pointMinSizeScale?: number;
  viewZoom?: number | null;
  color?: [number, number, number, number];
  featureCodes?: readonly number[];
  showTileDebugOverlay?: boolean;
  tileLoadCallbacks?: PointsTileLoadCallbacks;
  tileDebugStore?: TileDebugStore;
  /** Bumps when {@link tileDebugStore} contents change; forces debug overlay refresh. */
  tileDebugSignature?: string;
  use3d?: boolean;
}

interface PointsLayerState {
  preloadedBatch?: ColumnarNdarrayPointsBatch;
}

export class PointsLayer extends CompositeLayer<PointsLayerProps> {
  static layerName = 'PointsLayer';

  static defaultProps = {
    visible: true,
    opacity: 1,
    pointSize: DEFAULT_POINT_SIZE,
    pointRadiusMinPixels: DEFAULT_POINT_RADIUS_MIN_PIXELS,
    pointRadiusMaxPixels: DEFAULT_POINT_RADIUS_MAX_PIXELS,
    showTileDebugOverlay: true,
  } satisfies Partial<PointsLayerProps>;

  initializeState(): void {
    this.state = {};
    void this.ensurePreloadedBatch();
  }

  updateState(params: UpdateParameters<this>): void {
    const { props, oldProps } = params;
    if (
      props.resource.loader !== oldProps.resource.loader ||
      props.resource.element !== oldProps.resource.element
    ) {
      this.setState({ preloadedBatch: undefined });
      void this.ensurePreloadedBatch();
    }
  }

  private async ensurePreloadedBatch(): Promise<void> {
    const { resource } = this.props;
    if (resource.loader.capabilities.kind !== 'preloaded-columnar') {
      return;
    }
    const existing = (this.state as PointsLayerState).preloadedBatch;
    if (existing) {
      return;
    }
    const batch = await resource.loader.loadAll?.();
    if (batch?.format === 'columnar-ndarray') {
      this.setState({ preloadedBatch: batch });
    }
  }

  /** Public wrapper for strategy modules outside this class. */
  subLayerProps<P extends Record<string, unknown>>(props: P & { id: string }): P {
    return this.getSubLayerProps(props);
  }

  renderLayers(): Layer | null | LayersList {
    const { visible = true, resource } = this.props;
    if (!visible || !resource?.loader) {
      return null;
    }
    return resolvePointsRenderStrategy(resource.loader).renderLayers(this);
  }
}
