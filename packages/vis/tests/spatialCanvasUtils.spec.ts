import { describe, expect, it } from 'vitest';
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
