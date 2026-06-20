import type { Matrix4 } from '@math.gl/core';
import type { UpdateParameters } from '@deck.gl/core';
import { filterColumnarByFeatureCodesInWorker } from '@spatialdata/core';
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
  /** Source-side integer codes aligned with the preloaded table rows. */
  preloadedFeatureCodes?: ArrayLike<number>;
  showTileDebugOverlay?: boolean;
  tileLoadCallbacks?: PointsTileLoadCallbacks;
  tileDebugStore?: TileDebugStore;
  /** Bumps when {@link tileDebugStore} contents change; forces debug overlay refresh. */
  tileDebugSignature?: string;
  use3d?: boolean;
}

interface PointsLayerState {
  preloadedBatch?: ColumnarNdarrayPointsBatch;
  filteredBatch?: ColumnarNdarrayPointsBatch;
  filteredBatchSignature?: string;
  filterGeneration?: number;
}

function featureCodesSignature(featureCodes: readonly number[] | undefined): string {
  if (featureCodes === undefined) {
    return 'all';
  }
  if (featureCodes.length === 0) {
    return 'none';
  }
  return featureCodes.slice().sort((left, right) => left - right).join(',');
}

function emptyFilteredBatch(batch: ColumnarNdarrayPointsBatch): ColumnarNdarrayPointsBatch {
  const axisCount = batch.shape[0] ?? batch.data.length;
  const empty = new Float32Array(0);
  const emptyData =
    axisCount >= 3 && batch.data[2] ? [empty, empty, empty] : [empty, empty];
  return {
    ...batch,
    data: emptyData,
    shape: [axisCount, 0],
    pointCount: 0,
  };
}

async function filterPreloadedBatch(
  batch: ColumnarNdarrayPointsBatch,
  featureCodes: readonly number[] | undefined,
  preloadedFeatureCodes: ArrayLike<number> | undefined
): Promise<ColumnarNdarrayPointsBatch> {
  if (featureCodes === undefined || !preloadedFeatureCodes) {
    return batch;
  }
  if (featureCodes.length === 0) {
    return emptyFilteredBatch(batch);
  }
  const filtered = await filterColumnarByFeatureCodesInWorker(
    { shape: batch.shape, data: batch.data },
    featureCodes,
    preloadedFeatureCodes
  );
  return {
    ...batch,
    data: filtered.data,
    shape: filtered.shape,
    pointCount: filtered.shape[1] ?? filtered.data[0]?.length ?? 0,
  };
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
    this.state = { filterGeneration: 0 };
    void this.ensurePreloadedBatch();
  }

  updateState(params: UpdateParameters<this>): void {
    const { props, oldProps } = params;
    if (
      props.resource.loader !== oldProps.resource.loader ||
      props.resource.element !== oldProps.resource.element
    ) {
      this.setState({
        preloadedBatch: undefined,
        filteredBatch: undefined,
        filteredBatchSignature: undefined,
        filterGeneration: 0,
      });
      void this.ensurePreloadedBatch();
      return;
    }

    const signature = featureCodesSignature(props.featureCodes);
    const state = this.state as PointsLayerState;
    const preloadedBatch = state.preloadedBatch;
    if (
      preloadedBatch &&
      (signature !== state.filteredBatchSignature || !state.filteredBatch)
    ) {
      void this.ensureFilteredBatch(preloadedBatch, signature);
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
      void this.ensureFilteredBatch(batch, featureCodesSignature(this.props.featureCodes));
    }
  }

  private async ensureFilteredBatch(
    batch: ColumnarNdarrayPointsBatch,
    signature: string
  ): Promise<void> {
    const generation = ((this.state as PointsLayerState).filterGeneration ?? 0) + 1;
    this.setState({ filterGeneration: generation });
    const { featureCodes, preloadedFeatureCodes } = this.props;
    const filtered = await filterPreloadedBatch(batch, featureCodes, preloadedFeatureCodes);
    const state = this.state as PointsLayerState;
    if (state.filterGeneration !== generation) {
      return;
    }
    this.setState({
      filteredBatch: filtered,
      filteredBatchSignature: signature,
    });
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

export { filterPreloadedBatch, featureCodesSignature };
