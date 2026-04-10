import { Matrix4 } from '@math.gl/core';
import { describe, expect, it } from 'vitest';
import { calculateInitialViewState } from '../src/SpatialCanvas/utils.js';
import {
  DEFAULT_ZOOM_BACK_OFF,
  boundsFromPoints,
  boundsFromPolygons,
  unionBounds,
  unionBoundsList,
  viewStateFromBounds,
} from '../src/SpatialCanvas/viewStateFit.js';

describe('viewStateFromBounds', () => {
  it('centers target and matches Viv-style zoom (log2 scale minus backoff)', () => {
    const bounds = { minX: 0, minY: 0, maxX: 100, maxY: 100 };
    const vs = viewStateFromBounds(bounds, 400, 400, 0);
    expect(vs.target[0]).toBeCloseTo(50);
    expect(vs.target[1]).toBeCloseTo(50);
    const expectedZoom = Math.log2(Math.min(400 / 100, 400 / 100));
    expect(vs.zoom).toBeCloseTo(expectedZoom);
  });

  it('applies default zoom backoff like ImageView', () => {
    const bounds = { minX: 0, minY: 0, maxX: 100, maxY: 100 };
    const vs = viewStateFromBounds(bounds, 400, 400, DEFAULT_ZOOM_BACK_OFF);
    const unbacked = Math.log2(4);
    expect(vs.zoom).toBeCloseTo(unbacked - DEFAULT_ZOOM_BACK_OFF);
  });

  it('uses min dimension when viewport is not square', () => {
    const bounds = { minX: 0, minY: 0, maxX: 200, maxY: 100 };
    const vs = viewStateFromBounds(bounds, 400, 200, 0);
    const expectedZoom = Math.log2(Math.min(400 / 200, 200 / 100));
    expect(vs.zoom).toBeCloseTo(expectedZoom);
  });

  it('handles degenerate width with epsilon', () => {
    const bounds = { minX: 5, minY: 5, maxX: 5, maxY: 20 };
    const vs = viewStateFromBounds(bounds, 100, 100, 0);
    expect(vs.target[0]).toBe(5);
    expect(vs.target[1]).toBeCloseTo(12.5);
    expect(Number.isFinite(vs.zoom)).toBe(true);
  });
});

describe('unionBounds / unionBoundsList', () => {
  it('unions two rectangles', () => {
    const u = unionBounds(
      { minX: 0, minY: 0, maxX: 10, maxY: 10 },
      { minX: 5, minY: 5, maxX: 20, maxY: 15 }
    );
    expect(u).toEqual({ minX: 0, minY: 0, maxX: 20, maxY: 15 });
  });

  it('returns null for empty list', () => {
    expect(unionBoundsList([])).toBeNull();
  });

  it('reduces a list', () => {
    const u = unionBoundsList([
      { minX: 0, minY: 0, maxX: 1, maxY: 1 },
      { minX: 2, minY: 2, maxX: 3, maxY: 3 },
    ]);
    expect(u).toEqual({ minX: 0, minY: 0, maxX: 3, maxY: 3 });
  });
});

describe('boundsFromPolygons', () => {
  it('transforms vertices with modelMatrix', () => {
    const m = new Matrix4().translate([10, 20, 0]);
    const poly = [
      [
        [
          [0, 0],
          [1, 0],
          [0, 1],
        ],
      ],
    ];
    const b = boundsFromPolygons(poly, m);
    expect(b).not.toBeNull();
    expect(b?.minX).toBeCloseTo(10);
    expect(b?.minY).toBeCloseTo(20);
    expect(b?.maxX).toBeCloseTo(11);
    expect(b?.maxY).toBeCloseTo(21);
  });

  it('returns null for empty polygons', () => {
    expect(boundsFromPolygons([], new Matrix4())).toBeNull();
  });

  it('handles a single ring at top level (loader multipolygon slice)', () => {
    const m = new Matrix4().identity();
    const ring = [
      [0, 0],
      [2, 0],
      [0, 2],
    ];
    const b = boundsFromPolygons([ring] as unknown, m);
    expect(b).toEqual({ minX: 0, minY: 0, maxX: 2, maxY: 2 });
  });

  it('does not throw when ring mixes pairs and non-iterable garbage', () => {
    const m = new Matrix4().identity();
    const messy = [[[0, 0], 99, [1, 1]]] as unknown;
    expect(() => boundsFromPolygons(messy, m)).not.toThrow();
    const b = boundsFromPolygons(messy, m);
    expect(b).toBeNull();
  });
});

describe('boundsFromPoints', () => {
  it('returns bounds in world space', () => {
    const m = new Matrix4().identity();
    const b = boundsFromPoints(
      {
        shape: [2, 3],
        data: [
          [0, 2, 0],
          [0, 0, 3],
        ],
      },
      m,
      false
    );
    expect(b).toEqual({ minX: 0, minY: 0, maxX: 2, maxY: 3 });
  });
});

describe('calculateInitialViewState', () => {
  it('delegates to viewStateFromBounds', () => {
    const vs = calculateInitialViewState({ minX: 0, minY: 0, maxX: 100, maxY: 50 }, 200, 100);
    expect(vs.target[0]).toBeCloseTo(50);
    expect(vs.target[1]).toBeCloseTo(25);
  });

  it('returns origin when bounds are null', () => {
    expect(calculateInitialViewState(null, 100, 100)).toEqual({ target: [0, 0], zoom: 0 });
  });
});
