import { describe, expect, it } from 'vitest';
import { isHoverDuringDrag } from '../src/SpatialCanvas/useThrottledHoverTooltip.js';

describe('isHoverDuringDrag', () => {
  it('treats a hover with no held button as a normal hover', () => {
    expect(isHoverDuringDrag(undefined)).toBe(false);
    expect(isHoverDuringDrag(null)).toBe(false);
    expect(isHoverDuringDrag({})).toBe(false);
    expect(isHoverDuringDrag({ srcEvent: null })).toBe(false);
    expect(isHoverDuringDrag({ srcEvent: { buttons: 0 } })).toBe(false);
  });

  it('treats a hover with a held pointer button as an in-progress drag/pan', () => {
    expect(isHoverDuringDrag({ srcEvent: { buttons: 1 } })).toBe(true);
    expect(isHoverDuringDrag({ srcEvent: { buttons: 2 } })).toBe(true);
    expect(isHoverDuringDrag({ srcEvent: { buttons: 4 } })).toBe(true);
  });
});
