import type { SpatialData } from '@spatialdata/core';
import type { LayerConfig, LayerType } from '../../src/SpatialCanvas/types';
import { generateLayerId, getAvailableElements } from '../../src/SpatialCanvas/utils';

const STACK_ORDER: LayerType[] = ['image', 'labels', 'shapes', 'points'];

const COLLECTION_BY_TYPE = {
  image: 'images',
  labels: 'labels',
  shapes: 'shapes',
  points: 'points',
} as const;

export function buildHeadlessLayersForCoordinateSystem(
  spatialData: SpatialData,
  coordinateSystem: string
): { layers: Record<string, LayerConfig>; layerOrder: string[] } {
  const available = getAvailableElements(spatialData, coordinateSystem);
  const layers: Record<string, LayerConfig> = {};
  const layerOrder: string[] = [];

  for (const type of STACK_ORDER) {
    const collection = COLLECTION_BY_TYPE[type];
    for (const element of available[collection]) {
      const layerId = generateLayerId(element.type, element.key);
      const base = {
        id: layerId,
        elementKey: element.key,
        visible: true,
        opacity: 1,
      };
      // in future we might have some more type-helpers
      const config: LayerConfig =
        type === 'shapes'
          ? {
              ...base,
              type: 'shapes',
              fillColor: [70, 130, 180, 180],
              strokeColor: [255, 255, 255, 220],
              strokeWidth: 1,
            }
          : {
              ...base,
              type,
            };
      layers[layerId] = config;
      layerOrder.push(layerId);
    }
  }

  return { layers, layerOrder };
}
