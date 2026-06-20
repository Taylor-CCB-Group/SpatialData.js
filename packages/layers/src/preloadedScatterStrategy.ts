import type { Layer, LayersList } from 'deck.gl';
import type { PointsLayer } from './PointsLayer.js';
import type { PointsRenderStrategy } from './pointsRenderStrategies.js';
import {
  DEFAULT_POINT_SIZE,
  renderColumnarScatterLayer,
} from './pointsScatterLayer.js';
import type { ColumnarNdarrayPointsBatch } from './pointsLoader.js';

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

    const cached = (layer.state as { preloadedBatch?: ColumnarNdarrayPointsBatch })
      .preloadedBatch;
    if (!cached) {
      return null;
    }

    return renderColumnarScatterLayer(layer.props.id, cached, {
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
