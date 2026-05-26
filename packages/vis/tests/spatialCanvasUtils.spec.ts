import { describe, expect, it } from 'vitest';
import { resolveLayerElement } from '../src/SpatialCanvas/useLayerData.js';
import { calculateInitialViewState } from '../src/SpatialCanvas/utils.js';

describe('calculateInitialViewState (vis SpatialCanvas utils)', () => {
  it('delegates to core viewStateFromBounds', () => {
    const vs = calculateInitialViewState({ minX: 0, minY: 0, maxX: 100, maxY: 50 }, 200, 100);
    expect(vs.target[0]).toBeCloseTo(50);
    expect(vs.target[1]).toBeCloseTo(25);
  });

  it('returns origin when bounds are null', () => {
    expect(calculateInitialViewState(null, 100, 100)).toEqual({ target: [0, 0], zoom: 0 });
  });
});

describe('resolveLayerElement', () => {
  it('resolves controlled layer ids through elementKey', () => {
    const imageElement = {
      key: 'image-a',
      type: 'image',
      element: {},
      transform: {},
    } as any;
    const elements = new Map([[`${imageElement.type}:${imageElement.key}`, imageElement]]);

    expect(
      resolveLayerElement(
        'overlay-red',
        {
          id: 'overlay-red',
          type: 'image',
          elementKey: 'image-a',
          visible: true,
          opacity: 0.5,
        },
        elements
      )
    ).toBe(imageElement);
  });

  it('keeps generated layer ids working as a fallback', () => {
    const imageElement = {
      key: 'image-a',
      type: 'image',
      element: {},
      transform: {},
    } as any;
    const elements = new Map([['image:image-a', imageElement]]);

    expect(resolveLayerElement('image:image-a', undefined, elements)).toBeUndefined();
    expect(
      resolveLayerElement(
        'image:image-a',
        {
          id: 'image:image-a',
          type: 'image',
          elementKey: 'missing-old-config',
          visible: true,
          opacity: 1,
        },
        elements
      )
    ).toBe(imageElement);
  });
});
