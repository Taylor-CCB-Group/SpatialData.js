import { applyRenderCapToColumnar } from '@spatialdata/core';
import type { Layer, LayersList } from 'deck.gl';
import type { PointsLayer } from './PointsLayer.js';
import type { PointsRenderStrategy } from './pointsRenderStrategies.js';
import { featureFilterAwaitingRowCodes, filterBatchSignature } from './pointsFeatureCodes.js';
import {
  DEFAULT_POINT_SIZE,
  renderColumnarScatterLayer,
} from './pointsScatterLayer.js';
import type { ColumnarNdarrayPointsBatch } from './pointsLoader.js';

function resolveScatterBatch(layer: PointsLayer): ColumnarNdarrayPointsBatch | undefined {
  const { featureCodes, preloadedFeatureCodes, renderCap } = layer.props;
  const state = layer.state as {
    preloadedBatch?: ColumnarNdarrayPointsBatch;
    filteredBatch?: ColumnarNdarrayPointsBatch;
    filteredBatchSignature?: string;
  };
  const signature = filterBatchSignature(featureCodes, preloadedFeatureCodes, renderCap);
  const awaitingRowCodes = featureFilterAwaitingRowCodes(featureCodes, preloadedFeatureCodes);
  if (awaitingRowCodes) {
    if (!state.preloadedBatch) {
      return undefined;
    }
    return applyRenderCapToColumnar(state.preloadedBatch, renderCap);
  }
  if (state.filteredBatch && state.filteredBatchSignature === signature) {
    return state.filteredBatch;
  }
  if (!state.preloadedBatch) {
    return undefined;
  }
  return applyRenderCapToColumnar(state.preloadedBatch, renderCap);
}

export const preloadedScatterStrategy: PointsRenderStrategy = {
  renderLayers(layer): Layer | null | LayersList {
    const {
      resource,
      opacity = 1,
      visible = true,
      pointSize = DEFAULT_POINT_SIZE,
      pointRadiusMinPixels,
      pointRadiusMaxPixels,
      pointMinSizeScale,
      viewZoom,
      color = [255, 100, 100, 200],
      use3d,
    } = layer.props;

    if (!visible) {
      return null;
    }

    const batch = resolveScatterBatch(layer);
    if (!batch) {
      return null;
    }

    // Namespace the sublayer id via the composite's sublayer-props helper.
    // Passing layer.props.id raw makes the ScatterplotLayer collide with its
    // parent PointsLayer id (deck asserts on every frame). The morton strategy
    // already derives `${id}-scatter`; do the same here.
    return renderColumnarScatterLayer(`${layer.props.id}-scatter`, batch, {
      color,
      pointSize,
      pointRadiusMinPixels,
      pointRadiusMaxPixels,
      pointMinSizeScale,
      viewZoom,
      opacity,
      modelMatrix: layer.props.modelMatrix,
      use3d,
    });
  },
};
