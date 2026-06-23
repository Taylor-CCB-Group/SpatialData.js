import type { Layer, LayersList } from 'deck.gl';
import type { PointsEncodingKind, PointsLoader } from './pointsLoader.js';
import type { PointsLayer } from './PointsLayer.js';
import { geoArrowBinaryStrategy, geoArrowTiledStrategy, unsupportedPointsStrategy } from './geoArrowStrategies.js';
import { mortonTiledStrategy } from './mortonTiledStrategy.js';
import { preloadedScatterStrategy } from './preloadedScatterStrategy.js';

export interface PointsRenderStrategy {
  renderLayers(layer: PointsLayer): Layer | null | LayersList;
}

const STRATEGIES: Record<PointsEncodingKind, PointsRenderStrategy> = {
  'preloaded-columnar': preloadedScatterStrategy,
  'morton-tiled': mortonTiledStrategy,
  'geoarrow-binary': geoArrowBinaryStrategy,
  'geoarrow-tiled': geoArrowTiledStrategy,
};

export function resolvePointsRenderStrategy(loader: PointsLoader): PointsRenderStrategy {
  return STRATEGIES[loader.capabilities.kind] ?? unsupportedPointsStrategy;
}
