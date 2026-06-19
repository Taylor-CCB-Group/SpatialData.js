import type { SpatialData } from '@spatialdata/core';
import type { RenderStack, RenderStackSpatialElementType } from '../../src/index';
import { generateLayerId, getAvailableElements } from '../../src/SpatialCanvas/utils';

const STACK_ORDER: RenderStackSpatialElementType[] = ['image', 'labels', 'shapes', 'points'];

const COLLECTION_BY_TYPE = {
  image: 'images',
  labels: 'labels',
  shapes: 'shapes',
  points: 'points',
} as const;

export function buildHeadlessRenderStackForCoordinateSystem(
  spatialData: SpatialData,
  coordinateSystem: string
): RenderStack {
  const available = getAvailableElements(spatialData, coordinateSystem);
  const entries: RenderStack['entries'] = [];

  for (const type of STACK_ORDER) {
    const collection = COLLECTION_BY_TYPE[type];
    for (const element of available[collection]) {
      const layerId = generateLayerId(element.type, element.key);
      entries.push({
        kind: 'spatial',
        id: layerId,
        visible: true,
        source: {
          elementType: type,
          elementKey: element.key,
          coordinateSystem,
        },
        props:
          type === 'shapes'
            ? {
                opacity: 1,
                fillColor: [70, 130, 180, 180],
                strokeColor: [255, 255, 255, 220],
                strokeWidth: 1,
              }
            : {
                opacity: 1,
              },
      });
    }
  }

  return { schemaVersion: 1, entries };
}
