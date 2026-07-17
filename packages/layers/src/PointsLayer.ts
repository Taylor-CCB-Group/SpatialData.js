import type { UpdateParameters } from '@deck.gl/core';
import type { Matrix4 } from '@math.gl/core';
import { applyRenderCapToColumnar, filterColumnarByFeatureCodesInWorker } from '@spatialdata/core';
import type { Layer, LayersList } from 'deck.gl';
import { CompositeLayer } from 'deck.gl';
import {
  featureFilterAwaitingRowCodes,
  filterBatchSignature,
  hasPreloadedRowFeatureCodes,
} from './pointsFeatureCodes.js';
import type { ColumnarNdarrayPointsBatch, PointsRenderResource } from './pointsLoader.js';
import { resolvePointsRenderStrategy } from './pointsRenderStrategies.js';
import {
  DEFAULT_POINT_RADIUS_MAX_PIXELS,
  DEFAULT_POINT_RADIUS_MIN_PIXELS,
  DEFAULT_POINT_SIZE,
} from './pointsScatterLayer.js';
import type { TileDebugStore } from './pointsTiledDebugHooks.js';

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
  /** Colour points by their per-point feature code instead of the flat color. */
  colorByFeature?: boolean;
  featureCodes?: readonly number[];
  /** Source-side integer codes aligned with the preloaded table rows. */
  preloadedFeatureCodes?: ArrayLike<number>;
  /** Bumps when a stable resource's backing batch grows in place (the streaming
   * partial overlay, D10). A change re-reads `loader.loadAll()` WITHOUT resetting the
   * layer, so the overlay fills in without a per-chunk teardown. */
  resourceRevision?: number;
  /** Max rows to draw after feature filtering. */
  renderCap?: number;
  showTileDebugOverlay?: boolean;
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

function emptyFilteredBatch(batch: ColumnarNdarrayPointsBatch): ColumnarNdarrayPointsBatch {
  const axisCount = batch.shape[0] ?? batch.data.length;
  const empty = new Float32Array(0);
  const emptyData = axisCount >= 3 && batch.data[2] ? [empty, empty, empty] : [empty, empty];
  return {
    ...batch,
    data: emptyData,
    shape: [axisCount, 0],
    pointCount: 0,
    featureCodes: new Int32Array(0),
  };
}

async function filterPreloadedBatch(
  batch: ColumnarNdarrayPointsBatch,
  featureCodes: readonly number[] | undefined,
  preloadedFeatureCodes: ArrayLike<number> | undefined
): Promise<ColumnarNdarrayPointsBatch> {
  // No feature filter: draw everything, but carry the row-aligned codes so the
  // render path can colour by feature. `preloadedFeatureCodes` is aligned to the
  // full preloaded batch, so it maps row-for-row onto the unfiltered geometry.
  if (featureCodes === undefined) {
    return hasPreloadedRowFeatureCodes(preloadedFeatureCodes)
      ? { ...batch, featureCodes: preloadedFeatureCodes }
      : batch;
  }
  if (featureCodes.length === 0) {
    return emptyFilteredBatch(batch);
  }
  if (!hasPreloadedRowFeatureCodes(preloadedFeatureCodes)) {
    return batch;
  }
  const filtered = await filterColumnarByFeatureCodesInWorker(
    { shape: batch.shape, data: batch.data },
    featureCodes,
    preloadedFeatureCodes ?? []
  );
  const filteredShape = filtered.shape ?? [filtered.data.length, filtered.data[0]?.length ?? 0];
  const pointCount = filteredShape[1] ?? filtered.data[0]?.length ?? 0;
  return {
    ...batch,
    data: filtered.data,
    shape: filteredShape,
    pointCount,
    ...(filtered.featureCodes ? { featureCodes: filtered.featureCodes } : {}),
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
      props.resource.loader !== oldProps.resource?.loader ||
      props.resource.element !== oldProps.resource?.element
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

    // Same loader, but its stable backing batch was swapped in place (the streaming
    // partial overlay grows per chunk, D10; the base swaps resident↔matched↔streaming,
    // P2): re-read `loadAll` for the new buffer and re-filter, WITHOUT the reset above
    // — that is what keeps it from flashing. Return so the signature-filter pass below
    // does not run against the STALE `preloadedBatch` with the NEW codes (a swap
    // changes the batch and its row-aligned codes together); `refreshPreloadedBatch`
    // re-filters the new batch with the current props.
    if (props.resourceRevision !== oldProps.resourceRevision) {
      void this.refreshPreloadedBatch();
      return;
    }

    const signature = filterBatchSignature(
      props.featureCodes,
      props.preloadedFeatureCodes,
      props.renderCap
    );
    const state = this.state as PointsLayerState;
    const preloadedBatch = state.preloadedBatch;
    const awaitingRowCodes = featureFilterAwaitingRowCodes(
      props.featureCodes,
      props.preloadedFeatureCodes
    );
    const canFilter = !awaitingRowCodes;
    const rowCodesBecameReady =
      hasPreloadedRowFeatureCodes(props.preloadedFeatureCodes) &&
      !hasPreloadedRowFeatureCodes(oldProps.preloadedFeatureCodes);
    if (
      preloadedBatch &&
      canFilter &&
      (rowCodesBecameReady || signature !== state.filteredBatchSignature || !state.filteredBatch)
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
      const awaitingRowCodes = featureFilterAwaitingRowCodes(
        this.props.featureCodes,
        this.props.preloadedFeatureCodes
      );
      if (!awaitingRowCodes) {
        void this.ensureFilteredBatch(
          batch,
          filterBatchSignature(
            this.props.featureCodes,
            this.props.preloadedFeatureCodes,
            this.props.renderCap
          )
        );
      }
    }
  }

  /**
   * Re-read the (grown) batch from a stable loader whose backing buffer changed in
   * place — the D10 streaming overlay. Unlike {@link ensurePreloadedBatch} it has no
   * "already loaded" short-circuit (the whole point is to pick up the growth) and it
   * does not reset filter state, so the overlay updates without a teardown.
   */
  private async refreshPreloadedBatch(): Promise<void> {
    const { resource } = this.props;
    if (resource.loader.capabilities.kind !== 'preloaded-columnar') {
      return;
    }
    const batch = await resource.loader.loadAll?.();
    if (batch?.format !== 'columnar-ndarray') {
      return;
    }
    this.setState({ preloadedBatch: batch });
    const awaitingRowCodes = featureFilterAwaitingRowCodes(
      this.props.featureCodes,
      this.props.preloadedFeatureCodes
    );
    if (!awaitingRowCodes) {
      void this.ensureFilteredBatch(
        batch,
        filterBatchSignature(
          this.props.featureCodes,
          this.props.preloadedFeatureCodes,
          this.props.renderCap
        )
      );
    }
  }

  private async ensureFilteredBatch(
    batch: ColumnarNdarrayPointsBatch,
    signature: string
  ): Promise<void> {
    const generation = ((this.state as PointsLayerState).filterGeneration ?? 0) + 1;
    this.setState({ filterGeneration: generation });
    const { featureCodes, preloadedFeatureCodes, renderCap } = this.props;
    let filtered = await filterPreloadedBatch(batch, featureCodes, preloadedFeatureCodes);
    filtered = applyRenderCapToColumnar(filtered, renderCap);
    const state = this.state as PointsLayerState;
    if (state.filterGeneration !== generation) {
      return;
    }
    this.setState({
      filteredBatch: filtered,
      filteredBatchSignature: signature,
    });
    this.setNeedsUpdate();
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

export { featureCodesSignature, filterBatchSignature } from './pointsFeatureCodes.js';
export { filterPreloadedBatch };
