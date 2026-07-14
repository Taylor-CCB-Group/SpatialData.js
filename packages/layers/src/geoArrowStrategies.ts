import type { Layer, LayersList } from 'deck.gl';
import type { PointsRenderStrategy } from './pointsRenderStrategies.js';

export const geoArrowBinaryStrategy: PointsRenderStrategy = {
  renderLayers(): Layer | null | LayersList {
    return null;
  },
};

export const geoArrowTiledStrategy: PointsRenderStrategy = {
  renderLayers(): Layer | null | LayersList {
    return null;
  },
};

export const unsupportedPointsStrategy: PointsRenderStrategy = {
  renderLayers(layer): Layer | null | LayersList {
    console.debug(
      `[PointsLayer] Unsupported points encoding for element "${layer.props.resource.element.key}"`
    );
    return null;
  },
};
