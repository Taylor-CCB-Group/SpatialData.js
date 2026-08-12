import type { SpatialBounds } from './pointsTiling.js';

/**
 * deck's tile size, in the units its traversal indexes with. Everything below is
 * expressed against it: `getIdentityTileIndices` computes
 * `scale = 2^z * 512 / tileSize`, so a tile spans `tileSize / 2^z` **element-local**
 * units. Fixing it at 512 leaves `z` as the only free variable.
 */
export const POINTS_TILE_SIZE = 512;

/**
 * Rows a single tile may be expected to hold at the coarsest level.
 *
 * A tile is one request, decoded and uploaded whole, and deck shows nothing for it
 * until it lands — so an over-large tile trades progressive filling for one long
 * stall. 400k is roughly a tenth of the default resident cap, which keeps a coarse
 * tile comparable to a chunk of preload rather than to the whole element.
 */
export const POINTS_TILE_TARGET_ROWS = 400_000;

/** Tiles the deck cache may retain, when the artifact gives us nothing to derive from. */
const FALLBACK_CACHE_TILES = 24;

export interface PointsTileGrid {
  tileSize: number;
  minZoom: number;
  maxZoom: number;
  zoomOffset: number;
  maxRequests: number;
  maxCacheSize: number;
  /** Rows a coarsest-level tile is expected to hold — the unit of the cache budget. */
  estimatedRowsPerTile: number;
  /** Worst-case rows the tile cache can hold. Accounting, not a limit deck enforces. */
  cacheRowBudget: number;
}

export interface PointsTileGridInput {
  bounds: SpatialBounds;
  totalRows: number;
  /** Rows per row group — the granularity every read is rounded up to. */
  maxRowsPerGroup: number;
  /** Uniform scale of the layer's model matrix: local units -> world units. */
  modelMatrixScale: number;
  /** Row budget for the tile cache; defaults to the resident points memory cap. */
  cacheRowBudget?: number;
}

/** `z` at which a tile spans `span` local units. */
function zoomForSpan(span: number): number {
  return Math.log2(POINTS_TILE_SIZE / span);
}

/**
 * Choose the tile grid for a Morton artifact.
 *
 * The grid used to be one fixed level (`minZoom: -1, maxZoom: -1`), so every tile was
 * 1024 local units at every zoom: zooming in read a 1024-unit tile to look at 50
 * units of it, and the number 1024 came from deck's defaults rather than from the
 * data. Both ends are now derived, and both ends are real constraints:
 *
 * - **Coarsest** — a tile should hold at most {@link POINTS_TILE_TARGET_ROWS} rows, so
 *   one request stays a fraction of the layer rather than most of it.
 * - **Finest** — a tile should stay at least as large as one row group's footprint.
 *   Reads are rounded up to whole row groups, so below that size each tile still
 *   fetches a whole group while four tiles cover what one used to: the same bytes,
 *   more requests, more duplicate decoding. This is the same argument as
 *   `MORTON_ZCOVER_MAX_DEPTH` — resolution finer than the storage granularity is
 *   pure cost.
 *
 * Both come from one number, the point density `rows / area`: a row group's footprint
 * is `sqrt(maxRowsPerGroup / density)` and the coarse limit `sqrt(target / density)`.
 * On a 12.1M-point Xenium element (10871 x 3627 um, 50k-row groups) that is a floor of
 * ~402 um and a ceiling of ~1139 um — a narrow range, and worth knowing: the fixed
 * 1024 was accidentally near-optimal *for this artifact*, and would not be for one an
 * order of magnitude smaller or denser.
 *
 * `zoomOffset` couples `z` to the viewport. deck picks `z = ceil(viewport.zoom +
 * zoomOffset)` from a zoom expressed in WORLD units, while tile spans are in LOCAL
 * units; the model matrix is the difference, so `log2(scale)` is exactly the term that
 * makes a tile land at 256-512 screen pixels instead of at whatever the transform
 * happened to imply.
 */
export function mortonTileGrid(input: PointsTileGridInput): PointsTileGrid {
  const { bounds, totalRows, maxRowsPerGroup, modelMatrixScale } = input;
  const width = Math.max(0, bounds.maxX - bounds.minX);
  const height = Math.max(0, bounds.maxY - bounds.minY);
  const area = width * height;
  const density = area > 0 && totalRows > 0 ? totalRows / area : 0;

  // No density to reason from (an empty or degenerate artifact): keep the single
  // level the grid had before, so this can only ever be an improvement.
  if (density <= 0) {
    return {
      tileSize: POINTS_TILE_SIZE,
      minZoom: -1,
      maxZoom: -1,
      zoomOffset: 0,
      maxRequests: 6,
      maxCacheSize: FALLBACK_CACHE_TILES,
      estimatedRowsPerTile: 0,
      cacheRowBudget: 0,
    };
  }

  const rowGroupSpan = Math.sqrt(Math.max(1, maxRowsPerGroup) / density);
  const coarseSpan = Math.sqrt(POINTS_TILE_TARGET_ROWS / density);

  // Smaller span => larger z. floor/ceil each round TOWARDS the allowed span.
  const maxZoom = Math.floor(zoomForSpan(rowGroupSpan));
  let minZoom = Math.ceil(zoomForSpan(Math.max(coarseSpan, rowGroupSpan)));
  if (minZoom > maxZoom) {
    // A row group already covers more than the coarse budget (a sparse artifact, or
    // very large row groups). One level, at the row-group footprint.
    minZoom = maxZoom;
  }

  const coarsestSpan = POINTS_TILE_SIZE / 2 ** minZoom;
  const estimatedRowsPerTile = Math.round(density * coarsestSpan * coarsestSpan);
  const budget = input.cacheRowBudget ?? 0;
  const maxCacheSize =
    budget > 0 && estimatedRowsPerTile > 0
      ? Math.min(512, Math.max(16, Math.round(budget / estimatedRowsPerTile)))
      : FALLBACK_CACHE_TILES;

  return {
    tileSize: POINTS_TILE_SIZE,
    minZoom,
    maxZoom,
    // A non-finite or non-positive scale would poison every tile index.
    zoomOffset:
      Number.isFinite(modelMatrixScale) && modelMatrixScale > 0 ? Math.log2(modelMatrixScale) : 0,
    // Each request is a row-group range read plus a decode; deck's default of 6 is a
    // reasonable place to sit, but it is now a decision rather than an inheritance.
    maxRequests: 6,
    maxCacheSize,
    estimatedRowsPerTile,
    cacheRowBudget: maxCacheSize * estimatedRowsPerTile,
  };
}
