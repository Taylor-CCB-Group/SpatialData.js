import { applyRenderCapToColumnar } from '@spatialdata/core';
import type { Layer, LayersList } from 'deck.gl';
import type { PointsLayer } from './PointsLayer.js';
import type { PointsRenderStrategy } from './pointsRenderStrategies.js';
import {
  DEFAULT_POINT_SIZE,
  renderColumnarScatterLayer,
} from './pointsScatterLayer.js';
import type { ColumnarNdarrayPointsBatch } from './pointsLoader.js';

function resolveScatterBatch(layer: PointsLayer): ColumnarNdarrayPointsBatch | undefined {
  const state = layer.state as {
    preloadedBatch?: ColumnarNdarrayPointsBatch;
    filteredBatch?: ColumnarNdarrayPointsBatch;
  };
  if (state.filteredBatch) {
    return state.filteredBatch;
  }
  if (!state.preloadedBatch) {
    return undefined;
  }
  return applyRenderCapToColumnar(state.preloadedBatch, layer.props.renderCap);
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

    return renderColumnarScatterLayer(layer.props.id, batch, {
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
