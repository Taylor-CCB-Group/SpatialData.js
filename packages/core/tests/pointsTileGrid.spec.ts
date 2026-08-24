import { describe, expect, it } from 'vitest';
import { DEFAULT_POINTS_MEMORY_CAP } from '../src/pointsLimits.js';
import {
  mortonTileGrid,
  POINTS_TILE_SIZE,
  POINTS_TILE_TARGET_ROWS,
} from '../src/pointsTileGrid.js';

/** The real 12.1M-point Xenium transcripts element, for grounding. */
const XENIUM = {
  bounds: { minX: 3.42, minY: 2.45, maxX: 10874.72, maxY: 3629.29 },
  totalRows: 12_165_021,
  maxRowsPerGroup: 50_000,
  modelMatrixScale: 4.705882352941177,
};

/** Local units a tile spans at zoom level `z`. */
const spanAt = (z: number) => POINTS_TILE_SIZE / 2 ** z;

describe('morton tile grid', () => {
  it('brackets the levels between a row group and the row budget', () => {
    const grid = mortonTileGrid(XENIUM);
    const area =
      (XENIUM.bounds.maxX - XENIUM.bounds.minX) * (XENIUM.bounds.maxY - XENIUM.bounds.minY);
    const density = XENIUM.totalRows / area;

    // Finest level still covers at least one row group's footprint...
    expect(spanAt(grid.maxZoom) ** 2 * density).toBeGreaterThanOrEqual(XENIUM.maxRowsPerGroup);
    // ...and the coarsest stays within the per-tile row budget.
    expect(spanAt(grid.minZoom) ** 2 * density).toBeLessThanOrEqual(POINTS_TILE_TARGET_ROWS);
    expect(grid.minZoom).toBeLessThanOrEqual(grid.maxZoom);
  });

  it('subdivides, where the old fixed grid never did', () => {
    const grid = mortonTileGrid(XENIUM);
    expect(grid.maxZoom).toBeGreaterThan(grid.minZoom);
  });

  it('offsets zoom by the model matrix, so a tile lands near tileSize on screen', () => {
    const grid = mortonTileGrid(XENIUM);
    // deck: z = ceil(viewport.zoom + zoomOffset); a tile is tileSize/2^z LOCAL units,
    // which is scale x that in world units, which is 2^zoom x that in screen pixels.
    for (const viewportZoom of [-4, -3.2, -2.32, -1, 0]) {
      const z = Math.min(
        grid.maxZoom,
        Math.max(grid.minZoom, Math.ceil(viewportZoom + grid.zoomOffset))
      );
      const screenPx = spanAt(z) * XENIUM.modelMatrixScale * 2 ** viewportZoom;
      // Only levels inside the range can hit the target; clamped ends legitimately
      // over- or under-shoot, which is what min/maxZoom are FOR.
      if (z > grid.minZoom && z < grid.maxZoom) {
        expect(screenPx).toBeGreaterThan(POINTS_TILE_SIZE / 2);
        expect(screenPx).toBeLessThanOrEqual(POINTS_TILE_SIZE * 1.01);
      }
    }
  });

  it('states the tile cache budget in rows instead of leaving it to deck', () => {
    const grid = mortonTileGrid({ ...XENIUM, cacheRowBudget: 4_000_000 });
    expect(grid.maxCacheSize).toBeGreaterThan(0);
    expect(grid.estimatedRowsPerTile).toBeGreaterThan(0);
    expect(grid.cacheRowBudget).toBe(grid.maxCacheSize * grid.estimatedRowsPerTile);
    // deck's default is 5 x the selected tile count, which on a coarse viewport of
    // this element is ~220 tiles; whatever we choose has to be a stated number.
    expect(grid.maxCacheSize).toBeLessThan(220);
  });

  it('collapses to one level when a row group already exceeds the row budget', () => {
    // Huge row groups over a small extent: the floor is above the ceiling.
    const grid = mortonTileGrid({
      bounds: { minX: 0, minY: 0, maxX: 100, maxY: 100 },
      totalRows: 1_000_000,
      maxRowsPerGroup: 900_000,
      modelMatrixScale: 1,
    });
    expect(grid.minZoom).toBe(grid.maxZoom);
  });

  it('keeps the old single level when there is no density to reason from', () => {
    const degenerate = mortonTileGrid({
      bounds: { minX: 0, minY: 0, maxX: 0, maxY: 0 },
      totalRows: 0,
      maxRowsPerGroup: 0,
      modelMatrixScale: 1,
    });
    expect(degenerate).toMatchObject({ minZoom: -1, maxZoom: -1, zoomOffset: 0 });
  });

  it('ignores a model matrix scale that would poison every tile index', () => {
    for (const modelMatrixScale of [0, -3, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(mortonTileGrid({ ...XENIUM, modelMatrixScale }).zoomOffset).toBe(0);
    }
  });

  it('scales the grid to the artifact, not to a constant', () => {
    // A tenth the extent at the same row count is 100x denser, so its tiles must be
    // smaller in local units — the fixed 1024 could not express this.
    const dense = mortonTileGrid({
      ...XENIUM,
      bounds: { minX: 0, minY: 0, maxX: 1087, maxY: 363 },
    });
    expect(spanAt(dense.minZoom)).toBeLessThan(spanAt(mortonTileGrid(XENIUM).minZoom));
  });

  it('budgets the cache against the resident cap when none is given', () => {
    // The input contract says `cacheRowBudget` defaults to the resident points memory
    // cap. It used to default to 0, which fell through to the flat tile-count fallback,
    // so a direct caller silently got an unbudgeted cache.
    const implicit = mortonTileGrid(XENIUM);
    const explicit = mortonTileGrid({ ...XENIUM, cacheRowBudget: DEFAULT_POINTS_MEMORY_CAP });

    expect(implicit.maxCacheSize).toBe(explicit.maxCacheSize);
    expect(implicit.cacheRowBudget).toBe(explicit.cacheRowBudget);
    // ...and it is a real budget, not the fallback tile count.
    expect(implicit.maxCacheSize * implicit.estimatedRowsPerTile).toBeCloseTo(
      implicit.cacheRowBudget,
      6
    );
  });
});
