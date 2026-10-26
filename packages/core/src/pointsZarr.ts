/**
 * Reader for points elements stored as multiscale Zarr — the "points-zarr" draft
 * spec 0.1 proposed by merfisheyes
 * (https://github.com/kresnajenie/merfisheyes/blob/main/docs/points-zarr-spec.md).
 *
 * Experimental. The spec is one group's draft, built on maturity-0 zarr conventions
 * (`df:`, `enum:`) and a pilot `multiscales`; it may change under us.
 *
 * The format answers the two questions a Morton-sorted parquet cannot:
 *
 * - **Zoomed out.** Level k + 1 is a uniform random quarter of level k, so a coarse view
 *   reads a sample whose density is still honest, not a prefix of the file.
 * - **A few genes.** Each level holds the points twice: `tile_major` (by tile, then
 *   feature) for "everything here", and `feature_major` (by feature, then tile) for
 *   "these genes here", each one contiguous row range per tile row.
 *
 * Its `index/` arrays are in ROW NUMBERS and small enough to read before any point,
 * so a read is planned from counts alone: which level, which rows, how many.
 */
import * as zarr from 'zarrita';
import { z } from 'zod';
import type {
  PointsFeatureCatalog,
  PointsZarrTilingMetadata,
  SpatialBounds,
} from './pointsTiling.js';

/** `points:version` values this reader understands. */
export const POINTS_ZARR_SUPPORTED_VERSIONS: readonly string[] = ['0.1'];

/**
 * Where a points-zarr copy sits beside a standard points element: a subgroup of the
 * element, which standard readers ignore (ADR 0006).
 *
 * @experimental
 */
export const POINTS_ZARR_SIDECAR = 'experimental.points-zarr';

const gridSchema = z.object({
  origin: z.tuple([z.number(), z.number()]),
  tile_size: z.number().positive(),
  // [ny, nx]
  shape: z.tuple([z.number().int().positive(), z.number().int().positive()]),
});

const levelSchema = z.looseObject({
  asset: z.string(),
  'points:n_points': z.number().int().nonnegative(),
  'points:grid': gridSchema,
});

const pointsZarrAttrsSchema = z.looseObject({
  'points:version': z.string(),
  axes: z.array(z.string()).min(2),
  spatialdata_attrs: z.looseObject({ feature_key: z.string() }),
  multiscales: z.looseObject({ layout: z.array(levelSchema).min(1) }),
  'points:n_points': z.number().int().nonnegative(),
  'points:extent': z.tuple([z.array(z.number()), z.array(z.number())]).optional(),
});

/** Whether a points element's attrs declare the points-zarr format, at any version. */
export function isPointsZarrAttrs(attrs: unknown): boolean {
  return typeof attrs === 'object' && attrs !== null && 'points:version' in attrs;
}

export interface PointsZarrGrid {
  originX: number;
  originY: number;
  tileSize: number;
  nx: number;
  ny: number;
}

export interface PointsZarrLevel {
  index: number;
  /** The level group's name. */
  asset: string;
  nPoints: number;
  grid: PointsZarrGrid;
}

export interface PointsZarrInBoundsOptions {
  /** Points are returned from inside these bounds, `[min, max)` on each axis. */
  bounds: SpatialBounds;
  /**
   * The region the level is chosen for, when it differs from {@link bounds}. A tile
   * clipped by the element's extent must pick the same level as its unclipped
   * neighbours, or the density would visibly step at the clip.
   */
  levelBounds?: SpatialBounds;
  /**
   * Feature codes (indices into {@link PointsZarrSource.features}). Absent means every
   * feature; empty means none, as on the Morton tile path.
   */
  featureCodes?: readonly number[];
  /** Points this read may return, shared by the selected features. */
  pointBudget: number;
  signal?: AbortSignal;
}

export interface PointsZarrInBoundsResult {
  /** `x`, `y` and, for a 3-D element, `z`. */
  data: Float32Array[];
  /** Per-point feature code, aligned with {@link data}. */
  featureCodes: Uint32Array;
  pointCount: number;
  /**
   * The level each request was served from: one entry per selected feature, in the
   * order asked, or a single entry for an all-features read.
   */
  levels: number[];
  /** Rows read before the exact filter to {@link PointsZarrInBoundsOptions.bounds}. */
  rowsRead: number;
}

interface FeatureIndex {
  /** `feature_major` row where feature f starts; length n_features + 1. */
  rows: Float64Array;
  /** Entries of feature f in `feature_tile`/`feature_tile_count`; length n_features + 1. */
  ptr: Float64Array;
}

/** One feature's non-empty tiles at one level, with running counts for range sums. */
interface FeatureTiles {
  tiles: Float64Array;
  /** `cum[i]` = the feature's points in tiles `[0, i)`; length tiles + 1. */
  cum: Float64Array;
  /** `feature_major` row the feature's first tile starts at. */
  start: number;
}

interface TileIndex {
  /** `tile_major` row where tile t starts; length nx * ny + 1. */
  rows: Float64Array;
  /** Tiles holding at least one point. */
  occupied: number;
}

type Order = 'tile_major' | 'feature_major';

const abortError = () => new DOMException('The read was aborted', 'AbortError');

function throwIfAborted(signal: AbortSignal | undefined) {
  if (signal?.aborted) throw abortError();
}

/**
 * Points expected in `area` at one level for a set with `count` points spread over
 * `occupiedTiles` tiles of that level's grid. Density is measured over the tiles the
 * set occupies rather than the whole extent, so a gene confined to one region is not
 * read as sparse; and a region cannot hold more than the set has.
 */
function expectedPointsInArea(
  count: number,
  occupiedTiles: number,
  tileSize: number,
  area: number
): number {
  if (count <= 0 || occupiedTiles <= 0) return 0;
  const density = count / (occupiedTiles * tileSize * tileSize);
  return Math.min(count, density * area);
}

function boundsArea(bounds: SpatialBounds): number {
  return Math.max(0, bounds.maxX - bounds.minX) * Math.max(0, bounds.maxY - bounds.minY);
}

/**
 * The cached promise for `key`, made by `make()` on first use. A rejection is
 * forgotten, so a transient read error is retried by the next call rather than
 * returned to every later one.
 */
function memo<K, V>(cache: Map<K, Promise<V>>, key: K, make: () => Promise<V>): Promise<V> {
  const cached = cache.get(key);
  if (cached) return cached;
  const promise = make();
  cache.set(key, promise);
  promise.catch(() => {
    if (cache.get(key) === promise) cache.delete(key);
  });
  return promise;
}

/** First index of an ascending array whose value is >= x. */
function lowerBound(values: ArrayLike<number>, x: number): number {
  let lo = 0;
  let hi = values.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (values[mid] < x) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** A row range, with the feature code its rows carry when the order implies one. */
interface RowRange {
  lo: number;
  hi: number;
  /** Set for `feature_major` reads: every row in the range is this feature. */
  feature?: number;
}

/**
 * Join ascending ranges (one per tile row) when no whole chunk lies between them.
 *
 * The next tile row's rows usually start in the chunk where this one's end, or the
 * chunk after; read separately, zarrita fetches that chunk (and, sharded, its index)
 * once per range, having no cache. Reading the span instead fetches exactly the chunks
 * the separate reads would, each once. It is correct because the rows in the gap belong
 * to tiles outside the bounds and the exact filter drops them. Only ranges of the same
 * feature merge, so a `feature_major` span still carries one code.
 */
function mergeRanges(ranges: readonly RowRange[], chunkRows: number): RowRange[] {
  const chunk = (row: number) => Math.floor(row / chunkRows);
  const out: RowRange[] = [];
  for (const range of ranges) {
    const last = out[out.length - 1];
    if (last && last.feature === range.feature && chunk(range.lo) <= chunk(last.hi - 1) + 1) {
      last.hi = Math.max(last.hi, range.hi);
    } else {
      out.push({ ...range });
    }
  }
  return out;
}

/**
 * An opened points-zarr element. Holds its own index caches, so two layers on one
 * element share them and a second element never sees the first's.
 *
 * @experimental Reads a draft format (ADR 0006); its API may change with the spec.
 */
export class PointsZarrSource {
  readonly elementPath: string;
  readonly version: string;
  readonly axisNames: string[];
  readonly dims: 2 | 3;
  readonly featureKey: string;
  readonly levels: readonly PointsZarrLevel[];
  readonly totalRows: number;
  readonly bounds: SpatialBounds;

  private readonly root: zarr.Location<zarr.Readable>;
  private readonly arrays = new Map<string, Promise<zarr.Array<zarr.DataType, zarr.Readable>>>();
  private readonly columnMaps = new Map<string, Promise<Map<string, string>>>();
  private readonly featureIndexes = new Map<number, Promise<FeatureIndex>>();
  private readonly featureTilesCache = new Map<string, Promise<FeatureTiles>>();
  private readonly tileIndexes = new Map<number, Promise<TileIndex>>();
  private featureNames: readonly string[] = [];

  private constructor(
    root: zarr.Location<zarr.Readable>,
    elementPath: string,
    attrs: z.infer<typeof pointsZarrAttrsSchema>
  ) {
    this.root = root;
    this.elementPath = elementPath;
    this.version = attrs['points:version'];
    this.axisNames = attrs.axes;
    this.dims = attrs.axes.length >= 3 ? 3 : 2;
    this.featureKey = attrs.spatialdata_attrs.feature_key;
    this.totalRows = attrs['points:n_points'];
    this.levels = attrs.multiscales.layout.map((entry, index) => {
      const grid = entry['points:grid'];
      return {
        index,
        asset: entry.asset,
        nPoints: entry['points:n_points'],
        grid: {
          originX: grid.origin[0],
          originY: grid.origin[1],
          tileSize: grid.tile_size,
          ny: grid.shape[0],
          nx: grid.shape[1],
        },
      };
    });
    const extent = attrs['points:extent'];
    // `points:extent` is a SHOULD; the level-0 grid always covers every point.
    const g = this.levels[0].grid;
    this.bounds = extent
      ? { minX: extent[0][0], minY: extent[0][1], maxX: extent[1][0], maxY: extent[1][1] }
      : {
          minX: g.originX,
          minY: g.originY,
          maxX: g.originX + g.nx * g.tileSize,
          maxY: g.originY + g.ny * g.tileSize,
        };
  }

  /**
   * Open the element at `elementPath`. Reads the level-0 `feature_major` column names
   * and the feature column's `enum_values` — two small arrays — and nothing else.
   */
  static async open(
    store: zarr.Readable,
    elementPath: string,
    rawAttrs: unknown
  ): Promise<PointsZarrSource> {
    const parsed = pointsZarrAttrsSchema.safeParse(rawAttrs);
    if (!parsed.success) {
      throw new Error(
        `points-zarr element '${elementPath}' has invalid metadata: ${parsed.error.message}`
      );
    }
    const version = parsed.data['points:version'];
    if (!POINTS_ZARR_SUPPORTED_VERSIONS.includes(version)) {
      throw new Error(
        `points-zarr element '${elementPath}' is version ${version}; this reader supports ${POINTS_ZARR_SUPPORTED_VERSIONS.join(', ')}`
      );
    }
    const source = new PointsZarrSource(
      zarr.root(store).resolve(elementPath),
      elementPath,
      parsed.data
    );
    const columns = await source.columns(source.levels[0].asset, 'feature_major');
    const featurePath = columns.get(source.featureKey);
    if (!featurePath) {
      throw new Error(`points-zarr element '${elementPath}' has no '${source.featureKey}' column`);
    }
    source.featureNames = await source.readStrings(`${featurePath}/enum_values`);
    return source;
  }

  /** Feature names; a point's feature code indexes this. */
  get features(): readonly string[] {
    return this.featureNames;
  }

  /** What a tiling probe reports for this element. */
  get tilingMetadata(): PointsZarrTilingMetadata {
    return {
      kind: 'points-zarr',
      elementPath: this.elementPath,
      version: this.version,
      axisNames: this.axisNames,
      featureKey: this.featureKey,
      totalRows: this.totalRows,
      levelCount: this.levels.length,
      finestTileSize: this.levels[0].grid.tileSize,
      bounds: this.bounds,
    };
  }

  /**
   * The feature catalog, with exact counts. Codes are the enum's own, identical in
   * both orders and at every level (spec §4), so they need no reconciling. Costs one
   * read of level 0's `feature_rows` (n_features + 1 integers).
   */
  async featureCatalog(): Promise<PointsFeatureCatalog> {
    const counts = await this.featureCounts(0);
    return {
      featureKey: this.featureKey,
      entries: this.features.map((name, code) => ({ code, name, count: counts[code] })),
    };
  }

  /** Points per feature in a level. */
  async featureCounts(level = 0): Promise<Float64Array> {
    const { rows } = await this.featureIndex(level);
    return rows.subarray(1).map((end, f) => end - rows[f]);
  }

  /**
   * The points in `bounds`, at the finest level whose expected count fits the budget.
   *
   * With features selected, each picks its own level, smallest feature first, each
   * taking the finest level that fits an equal share of what the earlier ones left:
   * a rare gene is always drawn whole while an abundant one is sampled (the planner
   * merfisheyes' viewer uses). The expected count comes from density, not from the
   * exact count in these bounds, so every tile of one size picks the same level and a
   * view never shows a density seam between tiles.
   */
  async loadInBounds(options: PointsZarrInBoundsOptions): Promise<PointsZarrInBoundsResult> {
    const { bounds, signal } = options;
    const area = boundsArea(options.levelBounds ?? bounds);
    const selection = options.featureCodes?.filter(
      (code) => Number.isInteger(code) && code >= 0 && code < this.features.length
    );
    const ranges: { level: number; order: Order; ranges: RowRange[] }[] = [];
    const levels: number[] = [];

    if (selection) {
      const chosen = await this.chooseFeatureLevels(selection, area, options.pointBudget);
      throwIfAborted(signal);
      for (const [i, feature] of selection.entries()) {
        const level = chosen[i];
        levels.push(level);
        const tiles = await this.featureTiles(level, feature);
        throwIfAborted(signal);
        ranges.push({
          level,
          order: 'feature_major',
          ranges: this.featureRanges(level, feature, tiles, bounds),
        });
      }
    } else {
      const level = await this.chooseAllFeaturesLevel(area, options.pointBudget);
      throwIfAborted(signal);
      levels.push(level);
      const index = await this.tileIndex(level);
      throwIfAborted(signal);
      ranges.push({ level, order: 'tile_major', ranges: this.tileRanges(level, index, bounds) });
    }

    const merged = await Promise.all(
      ranges.map(async ({ level, order, ranges: list }) => ({
        level,
        order,
        ranges: mergeRanges(list, await this.chunkRows(level, order)),
      }))
    );
    const parts = await Promise.all(
      merged.flatMap(({ level, order, ranges: list }) =>
        list.map((range) => this.readRange(level, order, range, signal))
      )
    );
    throwIfAborted(signal);
    return this.filterToBounds(parts, bounds, levels);
  }

  // --- planning ------------------------------------------------------------------

  private async chooseFeatureLevels(
    selection: readonly number[],
    area: number,
    pointBudget: number
  ): Promise<number[]> {
    const indexes = await Promise.all(this.levels.map((l) => this.featureIndex(l.index)));
    const expected = (feature: number, level: number) => {
      const { rows, ptr } = indexes[level];
      return expectedPointsInArea(
        rows[feature + 1] - rows[feature],
        ptr[feature + 1] - ptr[feature],
        this.levels[level].grid.tileSize,
        area
      );
    };
    const coarsest = this.levels.length - 1;
    const order = selection
      .map((feature, i) => ({ feature, i, finest: expected(feature, 0) }))
      .sort((a, b) => a.finest - b.finest);
    const chosen = new Array<number>(selection.length).fill(coarsest);
    let remaining = pointBudget;
    for (const [rank, { feature, i }] of order.entries()) {
      const share = remaining / (order.length - rank);
      let level = coarsest;
      for (let l = 0; l < this.levels.length; l++) {
        if (expected(feature, l) <= share) {
          level = l;
          break;
        }
      }
      chosen[i] = level;
      remaining = Math.max(0, remaining - expected(feature, level));
    }
    return chosen;
  }

  /**
   * Walks from the coarsest level towards level 0 and stops at the first that does
   * not fit, so the large level-0 `tile_rows` is read only when level 1 already fits.
   */
  private async chooseAllFeaturesLevel(area: number, pointBudget: number): Promise<number> {
    let level = this.levels.length - 1;
    for (let l = this.levels.length - 1; l >= 0; l--) {
      const { occupied } = await this.tileIndex(l);
      const expected = expectedPointsInArea(
        this.levels[l].nPoints,
        occupied,
        this.levels[l].grid.tileSize,
        area
      );
      if (expected > pointBudget) break;
      level = l;
    }
    return level;
  }

  /** The level's tile range covering `bounds`, clamped to its grid. */
  private tileSpan(level: number, bounds: SpatialBounds) {
    const { originX, originY, tileSize, nx, ny } = this.levels[level].grid;
    const clamp = (v: number, n: number) => Math.min(n - 1, Math.max(0, v));
    return {
      tx0: clamp(Math.floor((bounds.minX - originX) / tileSize), nx),
      tx1: clamp(Math.floor((bounds.maxX - originX) / tileSize), nx),
      ty0: clamp(Math.floor((bounds.minY - originY) / tileSize), ny),
      ty1: clamp(Math.floor((bounds.maxY - originY) / tileSize), ny),
      nx,
    };
  }

  /** One `feature_major` range per tile row: a feature's rows there are contiguous. */
  private featureRanges(
    level: number,
    feature: number,
    tiles: FeatureTiles,
    bounds: SpatialBounds
  ): RowRange[] {
    const { tx0, tx1, ty0, ty1, nx } = this.tileSpan(level, bounds);
    const out: RowRange[] = [];
    for (let ty = ty0; ty <= ty1; ty++) {
      const i0 = lowerBound(tiles.tiles, ty * nx + tx0);
      const i1 = lowerBound(tiles.tiles, ty * nx + tx1 + 1);
      if (i1 > i0) {
        out.push({ lo: tiles.start + tiles.cum[i0], hi: tiles.start + tiles.cum[i1], feature });
      }
    }
    return out;
  }

  /** One `tile_major` range per tile row: tiles are numbered row-major. */
  private tileRanges(level: number, index: TileIndex, bounds: SpatialBounds): RowRange[] {
    const { tx0, tx1, ty0, ty1, nx } = this.tileSpan(level, bounds);
    const out: RowRange[] = [];
    for (let ty = ty0; ty <= ty1; ty++) {
      const lo = index.rows[ty * nx + tx0];
      const hi = index.rows[ty * nx + tx1 + 1];
      if (hi > lo) out.push({ lo, hi });
    }
    return out;
  }

  // --- reading -------------------------------------------------------------------

  /** Rows per read chunk of an order's coordinates (the inner chunk, when sharded). */
  private async chunkRows(level: number, order: Order): Promise<number> {
    const asset = this.levels[level].asset;
    const path = (await this.columns(asset, order)).get(this.axisNames[0]);
    if (!path)
      throw new Error(`points-zarr ${asset}/${order} has no '${this.axisNames[0]}' column`);
    return (await this.open(path)).chunks[0];
  }

  private async readRange(level: number, order: Order, range: RowRange, signal?: AbortSignal) {
    const asset = this.levels[level].asset;
    const columns = await this.columns(asset, order);
    const axes = this.axisNames.slice(0, this.dims);
    const coordinatePaths = axes.map((axis) => {
      const path = columns.get(axis);
      if (!path) throw new Error(`points-zarr ${asset}/${order} has no '${axis}' column`);
      return path;
    });
    const coordinates = Promise.all(
      coordinatePaths.map((path) => this.readFloat32(path, range.lo, range.hi, signal))
    );
    let codes: Promise<ArrayLike<number>> | undefined;
    if (range.feature === undefined) {
      const featurePath = columns.get(this.featureKey);
      if (!featurePath) {
        throw new Error(`points-zarr ${asset}/${order} has no '${this.featureKey}' column`);
      }
      codes = this.readNumbers(`${featurePath}/codes`, range.lo, range.hi, signal);
    }
    // Awaited together: awaiting one first would leave the other unhandled when a
    // cancelled tile rejects both.
    const [values, featureCodes] = await Promise.all([coordinates, codes]);
    return { range, coordinates: values, codes: featureCodes };
  }

  private filterToBounds(
    parts: { range: RowRange; coordinates: Float32Array[]; codes?: ArrayLike<number> }[],
    bounds: SpatialBounds,
    levels: number[]
  ): PointsZarrInBoundsResult {
    // Half-open, so a point on a shared tile edge is drawn by exactly one tile — except
    // at the element's own far edge, which is a point's coordinate and has no
    // neighbouring tile to draw it.
    const xEnd = bounds.maxX >= this.bounds.maxX;
    const yEnd = bounds.maxY >= this.bounds.maxY;
    const inside = (x: number, y: number) =>
      x >= bounds.minX &&
      (x < bounds.maxX || (xEnd && x === bounds.maxX)) &&
      y >= bounds.minY &&
      (y < bounds.maxY || (yEnd && y === bounds.maxY));
    // Count first and allocate exactly. The batch lives in deck's tile cache, so a view
    // onto a buffer sized to every row read would pin the rows the filter dropped — at
    // fine zoom, many times the rows kept.
    let rowsRead = 0;
    let n = 0;
    for (const { range, coordinates } of parts) {
      rowsRead += range.hi - range.lo;
      const [xs, ys] = coordinates;
      for (let i = 0; i < xs.length; i++) if (inside(xs[i], ys[i])) n++;
    }
    const data = Array.from({ length: this.dims }, () => new Float32Array(n));
    const featureCodes = new Uint32Array(n);
    let out = 0;
    for (const { range, coordinates, codes } of parts) {
      const [xs, ys] = coordinates;
      for (let i = 0; i < xs.length; i++) {
        if (!inside(xs[i], ys[i])) continue;
        for (let d = 0; d < this.dims; d++) data[d][out] = coordinates[d][i];
        featureCodes[out] = range.feature ?? codes?.[i] ?? 0;
        out++;
      }
    }
    return { data, featureCodes, pointCount: n, levels, rowsRead };
  }

  // --- index caches --------------------------------------------------------------

  private featureIndex(level: number): Promise<FeatureIndex> {
    return memo(this.featureIndexes, level, () => {
      const asset = this.levels[level].asset;
      return Promise.all([
        this.readNumbers(`${asset}/index/feature_rows`),
        this.readNumbers(`${asset}/index/feature_tile_ptr`),
      ]).then(([rows, ptr]) => ({ rows: Float64Array.from(rows), ptr: Float64Array.from(ptr) }));
    });
  }

  private featureTiles(level: number, feature: number): Promise<FeatureTiles> {
    return memo(this.featureTilesCache, `${level}/${feature}`, async () => {
      const asset = this.levels[level].asset;
      const { rows, ptr } = await this.featureIndex(level);
      const lo = ptr[feature];
      const hi = ptr[feature + 1];
      const [tiles, counts] =
        hi > lo
          ? await Promise.all([
              this.readNumbers(`${asset}/index/feature_tile`, lo, hi),
              this.readNumbers(`${asset}/index/feature_tile_count`, lo, hi),
            ])
          : [[], []];
      const cum = new Float64Array(counts.length + 1);
      for (let i = 0; i < counts.length; i++) cum[i + 1] = cum[i] + counts[i];
      return { tiles: Float64Array.from(tiles), cum, start: rows[feature] };
    });
  }

  private tileIndex(level: number): Promise<TileIndex> {
    return memo(this.tileIndexes, level, () =>
      this.readNumbers(`${this.levels[level].asset}/index/tile_rows`).then((values) => {
        const rows = Float64Array.from(values);
        let occupied = 0;
        for (let t = 0; t + 1 < rows.length; t++) if (rows[t + 1] > rows[t]) occupied++;
        return { rows, occupied };
      })
    );
  }

  /** Column name -> member path, for one order of one level (the `df:` convention). */
  private columns(asset: string, order: Order): Promise<Map<string, string>> {
    const key = `${asset}/${order}`;
    return memo(this.columnMaps, key, () =>
      this.readStrings(`${key}/columns`).then(
        (names) => new Map(names.map((name, i) => [name, `${key}/column_${i}`]))
      )
    );
  }

  // --- typed reads ---------------------------------------------------------------

  private open(path: string) {
    return memo(this.arrays, path, () => zarr.open(this.root.resolve(path), { kind: 'array' }));
  }

  private selection(lo?: number, hi?: number) {
    return lo === undefined ? null : [zarr.slice(lo, hi ?? null)];
  }

  private async readStrings(path: string): Promise<string[]> {
    const arr = await this.open(path);
    if (!arr.is('string')) {
      throw new Error(`points-zarr array '${path}' is ${arr.dtype}, expected string`);
    }
    const chunk = await zarr.get(arr, null);
    return Array.from(chunk.data, String);
  }

  /** Integer index arrays: uint64 row numbers come back as bigint and fit a double. */
  private async readNumbers(
    path: string,
    lo?: number,
    hi?: number,
    signal?: AbortSignal
  ): Promise<ArrayLike<number>> {
    const arr = await this.open(path);
    if (arr.is('bigint')) {
      const chunk = await zarr.get(arr, this.selection(lo, hi), { signal });
      return Float64Array.from(chunk.data, Number);
    }
    if (arr.is('number')) {
      return (await zarr.get(arr, this.selection(lo, hi), { signal })).data;
    }
    throw new Error(`points-zarr array '${path}' is ${arr.dtype}, expected a number type`);
  }

  private async readFloat32(path: string, lo: number, hi: number, signal?: AbortSignal) {
    const arr = await this.open(path);
    if (arr.is('float32')) {
      return (await zarr.get(arr, this.selection(lo, hi), { signal })).data;
    }
    if (arr.is('number')) {
      return Float32Array.from((await zarr.get(arr, this.selection(lo, hi), { signal })).data);
    }
    throw new Error(
      `points-zarr coordinate array '${path}' is ${arr.dtype}, expected a float type`
    );
  }
}
