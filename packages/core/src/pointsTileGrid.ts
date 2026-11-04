import { DEFAULT_POINTS_MEMORY_CAP } from './pointsLimits.js';
import type { SpatialBounds } from './pointsTiling.js';

/**
 * deck's tile size, in the units its traversal indexes with. Everything below is
 * expressed against it: `getIdentityTileIndices` computes
 * `scale = 2^z * 512 / tileSize`, so a tile spans `tileSize / 2^z` **element-local**
 * units. Fixing it at 512 leaves `z` as the only free variable.
 */
export const POINTS_TILE_SIZE = 512;

/**
 * Rows a single tile may be expected to hold at the coarsest level. A tile is one
 * request, decoded and uploaded whole, and deck shows nothing for it until it lands,
 * so an over-large tile trades progressive filling for one long stall.
 */
export const POINTS_TILE_TARGET_ROWS = 400_000;

/** Tiles the deck cache may retain, when the artifact gives us nothing to derive from. */
const FALLBACK_CACHE_TILES = 24;

/**
 * Most a decoded tile row weighs: x, y and z as float32 and a uint32 feature code. Turns
 * the row budget into the bytes deck evicts tiles by.
 */
export const POINTS_TILE_ROW_BYTES = 16;

/**
 * Tiles the deck cache may retain however little they hold. Bytes are the real bound;
 * this only stops tiles that report none (empty, or outside the data) piling up. Kept
 * well short of deck's 512-ish worst case because the `TileLayer` keeps a sublayer per
 * cached tile and diffs every one of them each frame (~0.035ms each, measured).
 */
const MAX_CACHE_TILES = 128;

export interface PointsTileGrid {
  tileSize: number;
  minZoom: number;
  maxZoom: number;
  zoomOffset: number;
  maxRequests: number;
  /** Backstop on the tile count; {@link PointsTileGrid.maxCacheByteSize} is the bound that applies. */
  maxCacheSize: number;
  /**
   * Bytes the deck tile cache may hold, against each tile's reported `byteLength`: the
   * row budget at {@link POINTS_TILE_ROW_BYTES}.
   */
  maxCacheByteSize: number;
  /** Rows a coarsest-level tile is expected to hold. */
  estimatedRowsPerTile: number;
  /** Rows the tile cache may hold, enforced through {@link PointsTileGrid.maxCacheByteSize}. */
  cacheRowBudget: number;
}

/**
 * The cache bounds for a row budget. Not tiles x rows-per-tile: a tile's size says how
 * much it MAY hold, not what it does. Sparse regions, finer levels and a multiscale
 * artifact's coarser levels all hold a fraction of the estimate, so a count derived from
 * it held 16 tiles where a zoom across a few levels touches ~50, and every zoom back
 * evicted and rebuilt them.
 */
function cacheBounds(budget: number) {
  return {
    maxCacheSize: MAX_CACHE_TILES,
    maxCacheByteSize: budget * POINTS_TILE_ROW_BYTES,
    cacheRowBudget: budget,
  };
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
 * Choose the tile grid for a Morton artifact. Both ends come from one number, the point
 * density `rows / area`, and both are real constraints:
 *
 * - **Coarsest** — at most {@link POINTS_TILE_TARGET_ROWS} rows, so one request stays a
 *   fraction of the layer rather than most of it: `sqrt(target / density)`.
 * - **Finest** — at least one row group's footprint, `sqrt(maxRowsPerGroup / density)`.
 *   Reads round up to whole row groups, so below that size each tile still fetches a
 *   whole group while four tiles cover what one used to: same bytes, more requests, more
 *   duplicate decoding. Same argument as `MORTON_ZCOVER_MAX_DEPTH`.
 *
 * `zoomOffset` couples `z` to the viewport: deck picks `z = ceil(viewport.zoom +
 * zoomOffset)` from a zoom expressed in WORLD units, while tile spans are in LOCAL units.
 * The model matrix is the difference, so `log2(scale)` is the term that makes a tile land
 * at 256-512 screen pixels rather than at whatever the transform happened to imply.
 *
 * Measurements behind the constants: docs/plans/points-morton-tiled-viewport-loading.md.
 */
export function mortonTileGrid(input: PointsTileGridInput): PointsTileGrid {
  const { bounds, totalRows, maxRowsPerGroup, modelMatrixScale } = input;
  const width = Math.max(0, bounds.maxX - bounds.minX);
  const height = Math.max(0, bounds.maxY - bounds.minY);
  const area = width * height;
  const density = area > 0 && totalRows > 0 ? totalRows / area : 0;

  // No density to reason from (an empty or degenerate artifact): one fixed level.
  if (density <= 0) {
    return {
      tileSize: POINTS_TILE_SIZE,
      minZoom: -1,
      maxZoom: -1,
      zoomOffset: 0,
      maxRequests: 6,
      ...cacheBounds(input.cacheRowBudget ?? DEFAULT_POINTS_MEMORY_CAP),
      maxCacheSize: FALLBACK_CACHE_TILES,
      estimatedRowsPerTile: 0,
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

  return {
    tileSize: POINTS_TILE_SIZE,
    minZoom,
    maxZoom,
    // A non-finite or non-positive scale would poison every tile index.
    zoomOffset:
      Number.isFinite(modelMatrixScale) && modelMatrixScale > 0 ? Math.log2(modelMatrixScale) : 0,
    // deck's default, kept deliberately: each request is a range read plus a decode.
    maxRequests: 6,
    ...cacheBounds(input.cacheRowBudget ?? DEFAULT_POINTS_MEMORY_CAP),
    estimatedRowsPerTile,
  };
}

export interface MultiscalePointsTileGridInput {
  bounds: SpatialBounds;
  /** Tile size of the artifact's finest grid: below it a read fetches the same rows. */
  finestTileSize: number;
  /** Uniform scale of the layer's model matrix: local units -> world units. */
  modelMatrixScale: number;
  /** Row budget for the tile cache; defaults to the resident points memory cap. */
  cacheRowBudget?: number;
}

/**
 * Choose the tile grid for a multiscale artifact (points-zarr). Unlike a Morton file,
 * a tile's size no longer decides how much it holds — the loader picks a coarser level
 * for a bigger tile, keeping each near {@link POINTS_TILE_TARGET_ROWS} — so both ends
 * are set by geometry alone:
 *
 * - **Coarsest** — one tile covers the whole extent, which draws the coarsest level.
 * - **Finest** — one tile of the artifact's finest grid. Smaller deck tiles would read
 *   the same row ranges and throw more of them away.
 *
 * @experimental
 */
export function multiscaleTileGrid(input: MultiscalePointsTileGridInput): PointsTileGrid {
  const { bounds, finestTileSize, modelMatrixScale } = input;
  const span = Math.max(bounds.maxX - bounds.minX, bounds.maxY - bounds.minY);
  const minZoom = span > 0 ? Math.floor(zoomForSpan(span)) : 0;
  const maxZoom =
    finestTileSize > 0 ? Math.max(minZoom, Math.floor(zoomForSpan(finestTileSize))) : minZoom;
  return {
    tileSize: POINTS_TILE_SIZE,
    minZoom,
    maxZoom,
    zoomOffset:
      Number.isFinite(modelMatrixScale) && modelMatrixScale > 0 ? Math.log2(modelMatrixScale) : 0,
    maxRequests: 6,
    ...cacheBounds(input.cacheRowBudget ?? DEFAULT_POINTS_MEMORY_CAP),
    estimatedRowsPerTile: POINTS_TILE_TARGET_ROWS,
  };
}
