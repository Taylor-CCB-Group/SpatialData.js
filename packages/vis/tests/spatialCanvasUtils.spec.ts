import { Matrix4 } from '@math.gl/core';
import { describe, expect, it } from 'vitest';
import { getCachedWorldBounds, resolveLayerElement } from '../src/SpatialCanvas/useLayerData.js';
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

describe('getCachedWorldBounds', () => {
  it('reuses structural bounds across cosmetic rerenders', () => {
    const cache = new Map();
    const dataRef = { polygons: [] };
    const transformRef = new Matrix4();
    let calls = 0;

    const first = getCachedWorldBounds(cache, 'shapes:cells', dataRef, transformRef, () => {
      calls += 1;
      return { minX: 0, minY: 0, maxX: 10, maxY: 10 };
    });
    const second = getCachedWorldBounds(cache, 'shapes:cells', dataRef, transformRef, () => {
      calls += 1;
      return { minX: 100, minY: 100, maxX: 200, maxY: 200 };
    });

    expect(first).toEqual({ minX: 0, minY: 0, maxX: 10, maxY: 10 });
    expect(second).toBe(first);
    expect(calls).toBe(1);
  });

  it('recomputes when structural data changes', () => {
    const cache = new Map();
    const transformRef = new Matrix4();
    const initialData = { polygons: [] };
    const nextData = { polygons: [] };
    let calls = 0;

    getCachedWorldBounds(cache, 'shapes:cells', initialData, transformRef, () => {
      calls += 1;
      return { minX: 0, minY: 0, maxX: 10, maxY: 10 };
    });
    const next = getCachedWorldBounds(cache, 'shapes:cells', nextData, transformRef, () => {
      calls += 1;
      return { minX: 20, minY: 20, maxX: 30, maxY: 30 };
    });

    expect(next).toEqual({ minX: 20, minY: 20, maxX: 30, maxY: 30 });
    expect(calls).toBe(2);
  });
});
