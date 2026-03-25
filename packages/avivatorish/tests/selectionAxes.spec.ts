import { describe, expect, it } from 'vitest';
import { clampVivSelectionsToAxes, getVivSelectionAxisSizes } from '../src/utils';

describe('getVivSelectionAxisSizes', () => {
  it('returns only axes present in labels (case-insensitive)', () => {
    expect(getVivSelectionAxisSizes(['C', 'y', 'x'], [4, 256, 256])).toEqual({ c: 4 });
  });

  it('returns z and t when present', () => {
    expect(getVivSelectionAxisSizes(['t', 'c', 'z', 'y', 'x'], [5, 2, 8, 64, 64])).toEqual({
      t: 5,
      c: 2,
      z: 8,
    });
  });

  it('returns empty object for yx-only labels', () => {
    expect(getVivSelectionAxisSizes(['y', 'x'], [512, 512])).toEqual({});
  });
});

describe('clampVivSelectionsToAxes', () => {
  it('drops keys for axes not in the loader', () => {
    const axisSizes = { c: 3 };
    expect(
      clampVivSelectionsToAxes([{ z: 0, c: 1, t: 0 }], axisSizes),
    ).toEqual([{ c: 1 }]);
  });

  it('clamps to dimension bounds', () => {
    const axisSizes = { c: 2 };
    expect(clampVivSelectionsToAxes([{ c: 99 }], axisSizes)).toEqual([{ c: 1 }]);
  });

  it('yields empty objects when no z/c/t axes exist', () => {
    expect(clampVivSelectionsToAxes([{ z: 0, c: 0, t: 0 }], {})).toEqual([{}]);
  });
});
