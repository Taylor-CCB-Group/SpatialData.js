import type { Table as ArrowTable } from 'apache-arrow';
import type { AxisAlignedBounds, PointsColumnarData } from './spatialViewFit.js';

export const MORTON_CODE_2D_COLUMN = 'morton_code_2d';
export const MORTON_CODE_EXTREME_VALUE_INDICATOR = 0;
export const MORTON_CODE_BITS_PER_AXIS = 16;
export const MORTON_CODE_VALUE_MAX = 2 ** MORTON_CODE_BITS_PER_AXIS - 1;

export type SpatialBounds = AxisAlignedBounds;

/** Whether a points layer probes for a Morton index before preloading (D5). */
export type PointsTilingMode = 'auto' | 'off';

/**
 * On a Morton element the tiled path is the better one, not merely an alternative: the
 * preload it replaces keeps the first `cap` rows in FILE order, which on a Morton
 * artifact is a prefix of the Z-curve — a spatially skewed chunk of the slide, not a
 * sample of it. Anything else answers `null` from the schema alone and costs nothing.
 */
export const DEFAULT_POINTS_TILING: PointsTilingMode = 'auto';

/**
 * Resolve the tiling mode, default included. Call this instead of comparing to `'auto'`:
 * the resolver, the render hook and the panel must all read the default the same way.
 */
export function pointsTilingEnabled(mode: PointsTilingMode | undefined): boolean {
  return (mode ?? DEFAULT_POINTS_TILING) === 'auto';
}

export interface PointsFeatureEntry {
  code: number;
  name: string;
  /** Row count in the dataset or loaded sample, when known. */
  count?: number;
}

export interface PointsFeatureCatalog {
  featureKey: string;
  entries: PointsFeatureEntry[];
}

export interface PointsInBoundsOptions {
  bounds: SpatialBounds;
  /** Integer codes matching `{feature_key}_codes` in the Morton Parquet artifact. */
  featureCodes?: readonly number[];
  zoom?: number;
  signal?: AbortSignal;
  columns?: string[];
}

export interface PointsTilingMetadata {
  kind: 'morton-points';
  parquetPath: string;
  axisNames: string[];
  featureKey?: string;
  featureCodeColumnName: string;
  mortonCodeColumnName: typeof MORTON_CODE_2D_COLUMN;
  totalRows: number;
  totalRowGroups: number;
  maxRowsPerGroup: number;
  rowGroupRowCounts?: number[];
  supportsRowGroupRangeReads: boolean;
  bounds?: SpatialBounds;
  /**
   * Per-row-group `[min, max]` of the Morton column, read from footer statistics
   * during the probe. Present means viewport queries can select row groups from
   * memory ({@link selectMortonRowGroups}); absent means falling back to the bisect,
   * which pays ~2MB per step to recover the same two numbers.
   */
  rowGroupMortonExtents?: MortonRowGroupExtent[];
}

export type PointsInBoundsResponse = PointsColumnarData & {
  bounds: SpatialBounds;
  loadMode: 'row-groups' | 'full-filter';
  tiling?: PointsTilingMetadata;
  featureIndices?: ArrayLike<number>;
};

export function origCoordToNormCoord(x: number, y: number, bbox: SpatialBounds): [number, number] {
  const xRange = bbox.maxX - bbox.minX;
  const yRange = bbox.maxY - bbox.minY;
  if (xRange <= 0 || yRange <= 0) {
    return [0, 0];
  }
  return [
    Math.max(
      0,
      Math.min(
        MORTON_CODE_VALUE_MAX,
        Math.floor(((x - bbox.minX) / xRange) * MORTON_CODE_VALUE_MAX)
      )
    ),
    Math.max(
      0,
      Math.min(
        MORTON_CODE_VALUE_MAX,
        Math.floor(((y - bbox.minY) / yRange) * MORTON_CODE_VALUE_MAX)
      )
    ),
  ];
}

/** Spread the low 16 bits of `n` into the even bit positions of a 32-bit lane. */
function spreadBits(n: number): number {
  let x = n & 0xffff;
  x = (x | (x << 8)) & 0x00ff00ff;
  x = (x | (x << 4)) & 0x0f0f0f0f;
  x = (x | (x << 2)) & 0x33333333;
  x = (x | (x << 1)) & 0x55555555;
  return x;
}

/**
 * Interleave a quantised (x, y) pair into the code stored in `morton_code_2d`:
 * x in the even bits, y in the odd ones.
 *
 * `+ ... * 2` rather than `| ... << 1` on purpose — the y term reaches bit 31, and
 * JS bitwise operators would hand back a negative int32 for the top of the domain.
 *
 * Must agree with {@link zcoverRectangle}'s quadrant order (child +1 is x-high, +2 is
 * y-high) and with the writer; {@link mortonBoundsAgreeWithCodes} checks that against real
 * rows.
 */
export function mortonCode2dFromNormCoord(nx: number, ny: number): number {
  return spreadBits(nx) + spreadBits(ny) * 2;
}

/** The code a point *should* carry if `bbox` is the quantisation domain. */
export function mortonCode2dForPoint(x: number, y: number, bbox: SpatialBounds): number {
  const [nx, ny] = origCoordToNormCoord(x, y, bbox);
  return mortonCode2dFromNormCoord(nx, ny);
}

/**
 * Does `bounds` describe the domain the stored Morton codes were actually quantised
 * against? Recomputes the code for a sample of real rows and counts agreement.
 *
 * The sentinel rows are a **claim the artifact makes about itself**, and nothing in the
 * file forces them to be true. A wrong one fails silently and subtractively: the tile
 * grid is clipped to the bogus box so whole regions are never requested. Points are
 * never misplaced (the reader re-filters to the query bounds), so the only symptom is
 * that some of the map is missing.
 *
 * A majority rather than an exact match, because a coordinate on a cell boundary can
 * floor either way. Samples are spread evenly: consecutive rows in a Morton-sorted group
 * share a long code prefix, so the first N agree or disagree together.
 */
export function mortonBoundsAgreeWithCodes(
  xs: ArrayLike<number>,
  ys: ArrayLike<number>,
  codes: ArrayLike<number | bigint>,
  bounds: SpatialBounds,
  maxSamples = 64
): { checked: number; matched: number } {
  const rows = Math.min(xs.length, ys.length, codes.length);
  if (rows === 0 || maxSamples <= 0) {
    return { checked: 0, matched: 0 };
  }
  const samples = Math.min(rows, maxSamples);
  const stride = Math.max(1, Math.floor(rows / samples));
  let checked = 0;
  let matched = 0;
  for (let i = 0; i < rows && checked < samples; i += stride) {
    const x = getNumericValue(xs[i]);
    const y = getNumericValue(ys[i]);
    const code = getNumericValue(codes[i]);
    if (x === null || y === null || code === null) {
      continue;
    }
    checked += 1;
    if (mortonCode2dForPoint(x, y, bounds) === code) {
      matched += 1;
    }
  }
  return { checked, matched };
}

/** Inclusive `[min, max]` a row group's Morton column spans; `null` when unknown. */
export type MortonRowGroupExtent = readonly [number, number] | null;

/**
 * Is the file actually Morton-**sorted**, row group by row group?
 *
 * The row-group bisect binary-searches this sequence, which is only meaningful if it is
 * non-decreasing. A feature-primary artifact — sorted `(feature, morton)` — carries the
 * same column restarting at every feature boundary, so each row group spans nearly the
 * whole code range and the bisect lands arbitrarily: a tile comes back holding whichever
 * feature blocks lived in the groups it picked.
 *
 * Adjacent groups may share a boundary value, so the test is `min >= previous max`.
 * A `null` extent is unknown rather than out of order: skip it and carry the last
 * known maximum, so a column without statistics cannot fake a descent.
 *
 * An extent that is not a range at all — non-finite, or `min > max` — is rejected rather
 * than skipped. It cannot come from healthy statistics, so it means the decode is wrong,
 * and a mis-decoded index is exactly what this gate exists to keep tiling away from. It
 * would otherwise pass silently as the first or only extent, and `selectMortonRowGroups`
 * treats an inverted range as intersecting nothing: the row group would be dropped from
 * every query.
 */
export function mortonRowGroupExtentsAreSorted(extents: readonly MortonRowGroupExtent[]): boolean {
  let previousMax: number | null = null;
  for (const extent of extents) {
    if (!extent) {
      continue;
    }
    const [min, max] = extent;
    if (!Number.isFinite(min) || !Number.isFinite(max) || min > max) {
      return false;
    }
    if (previousMax !== null && min < previousMax) {
      return false;
    }
    previousMax = previousMax === null ? max : Math.max(previousMax, max);
  }
  return true;
}

/**
 * The row-group order as a THREE-state verdict, which is what the tiling gate needs.
 *
 * {@link mortonRowGroupExtentsAreSorted} skips `null` extents, so it answers `true` for
 * an empty list and for a list of all nulls — a "sorted" verdict on no evidence at all.
 * Both are reachable: an empty list means the footer would not parse or its row-group
 * count disagreed, and an all-null list means the column carries no statistics. Reading
 * either as "sorted" lets a feature-primary artifact through the one gate that exists to
 * stop it, and an all-null index is worse still, because `selectMortonRowGroups` includes
 * every unknown extent — so every tile scans the whole file.
 *
 * `'unverified'` must be treated like `'unsorted'` at the gate. It is separate only so the
 * warning can say which happened.
 */
export type MortonRowGroupOrder = 'sorted' | 'unsorted' | 'unverified';

export function mortonRowGroupOrderVerdict(
  extents: readonly MortonRowGroupExtent[]
): MortonRowGroupOrder {
  if (!extents.some((extent) => extent !== null)) {
    return 'unverified';
  }
  return mortonRowGroupExtentsAreSorted(extents) ? 'sorted' : 'unsorted';
}

/**
 * Which row groups can hold a code inside any of `intervals`, from the in-memory
 * index rather than a bisect over the file.
 *
 * The bisect this replaces reads the row group's BYTES to recover two boundary values —
 * every column, ~2MB on a real transcripts artifact — `log2(rowGroups)` times per
 * interval. The same numbers are in the parquet footer, so this costs nothing.
 *
 * Also *stricter* than the bisect, which tested only `max` and assumed the groups tile
 * the code space without gaps: this intersects both ends. A `null` extent means "no
 * statistics for this group" and is included, because the alternative is dropping rows
 * for a reason unrelated to the query.
 */
export function selectMortonRowGroups(
  extents: readonly MortonRowGroupExtent[],
  intervals: ReadonlyArray<readonly [number, number]>
): number[] {
  const selected = new Set<number>();
  for (let i = 0; i < extents.length; i++) {
    const extent = extents[i];
    if (!extent) {
      selected.add(i);
      continue;
    }
    const [min, max] = extent;
    for (const [start, end] of intervals) {
      if (max >= start && min <= end) {
        selected.add(i);
        break;
      }
    }
  }
  return [...selected].sort((a, b) => a - b);
}

function intersects(
  ax0: number,
  ay0: number,
  ax1: number,
  ay1: number,
  bx0: number,
  by0: number,
  bx1: number,
  by1: number
) {
  return !(ax1 < bx0 || bx1 < ax0 || ay1 < by0 || by1 < ay0);
}

function contained(
  ix0: number,
  iy0: number,
  ix1: number,
  iy1: number,
  ox0: number,
  oy0: number,
  ox1: number,
  oy1: number
) {
  return ox0 <= ix0 && ix0 <= ix1 && ix1 <= ox1 && oy0 <= iy0 && iy0 <= iy1 && iy1 <= oy1;
}

function cellRange(prefix: number, level: number, bits: number): [number, number] {
  const shift = 2 * (bits - level);
  const power = 2 ** shift;
  return [prefix * power, (prefix + 1) * power - 1];
}

export function mergeAdjacentIntervals(
  intervals: Array<[number, number]>
): Array<[number, number]> {
  if (intervals.length === 0) {
    return [];
  }
  const sorted = [...intervals].sort((a, b) => a[0] - b[0]);
  const merged: Array<[number, number]> = [sorted[0]];
  for (const [lo, hi] of sorted.slice(1)) {
    const last = merged[merged.length - 1];
    if (lo <= last[1] + 1) {
      last[1] = Math.max(last[1], hi);
    } else {
      merged.push([lo, hi]);
    }
  }
  return merged;
}

/**
 * How far {@link zcoverRectangle} subdivides before emitting a whole cell.
 *
 * The cover exists to pick **row groups**, so resolving the rectangle to individual
 * quantised cells buys nothing and costs a great deal. Measured on a 12.1M-point Xenium
 * artifact (245 row groups) over a viewport tile, the whole slide and a zoomed-in box,
 * the selected row groups at this depth are **identical** to the full-depth cover, not
 * merely a superset:
 *
 * | depth | intervals (viewport tile) | row groups |
 * |-------|---------------------------|------------|
 * | 16    | 38,014                    | 92         |
 * | 10    | 521                       | 92         |
 * | 8     | 138                       | 92         |
 *
 * 10 leaves headroom: 4^10 cells stays finer than the row-group granularity up to ~1M
 * row groups, where 8 would start over-fetching.
 */
export const MORTON_ZCOVER_MAX_DEPTH = 10;

/**
 * Morton-code intervals covering a rectangle in quantised (x, y) space.
 *
 * Stopping early at {@link maxDepth} makes a cell **coarser than the rectangle** —
 * the interval then covers some codes outside it. That is safe in both directions:
 * the cover is still complete (no code inside the rectangle is dropped), and the
 * extra codes only ever widen the row-group set, whose rows are filtered against the
 * exact bounds after the read.
 */
export function zcoverRectangle(
  rx0: number,
  ry0: number,
  rx1: number,
  ry1: number,
  bits = MORTON_CODE_BITS_PER_AXIS,
  maxDepth = MORTON_ZCOVER_MAX_DEPTH
): Array<[number, number]> {
  const maxCoord = 2 ** bits - 1;
  const depthLimit = Math.max(0, Math.min(bits, maxDepth));
  const x0 = Math.max(0, Math.min(maxCoord, Math.min(rx0, rx1)));
  const x1 = Math.max(0, Math.min(maxCoord, Math.max(rx0, rx1)));
  const y0 = Math.max(0, Math.min(maxCoord, Math.min(ry0, ry1)));
  const y1 = Math.max(0, Math.min(maxCoord, Math.max(ry0, ry1)));

  const intervals: Array<[number, number]> = [];
  const stack: Array<[number, number, number, number, number, number]> = [
    [0, 0, 0, 0, maxCoord, maxCoord],
  ];

  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) {
      continue;
    }
    const [prefix, level, xmin, ymin, xmax, ymax] = current;
    if (!intersects(xmin, ymin, xmax, ymax, x0, y0, x1, y1)) {
      continue;
    }
    if (contained(xmin, ymin, xmax, ymax, x0, y0, x1, y1) || level >= depthLimit) {
      intervals.push(cellRange(prefix, level, bits));
      continue;
    }

    const midx = Math.floor((xmin + xmax) / 2);
    const midy = Math.floor((ymin + ymax) / 2);
    const nextPrefix = prefix * 4;
    stack.push([nextPrefix + 0, level + 1, xmin, ymin, midx, midy]);
    stack.push([nextPrefix + 1, level + 1, midx + 1, ymin, xmax, midy]);
    stack.push([nextPrefix + 2, level + 1, xmin, midy + 1, midx, ymax]);
    stack.push([nextPrefix + 3, level + 1, midx + 1, midy + 1, xmax, ymax]);
  }

  return mergeAdjacentIntervals(intervals);
}

export function mortonIntervalsForBounds(
  allPointsBounds: SpatialBounds,
  queryBounds: SpatialBounds
): Array<[number, number]> {
  const [x0, y0] = origCoordToNormCoord(queryBounds.minX, queryBounds.minY, allPointsBounds);
  const [x1, y1] = origCoordToNormCoord(queryBounds.maxX, queryBounds.maxY, allPointsBounds);
  return zcoverRectangle(x0, y0, x1, y1);
}

function getNumericValue(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'bigint') {
    return Number(value);
  }
  return null;
}

export function isMortonSentinelValue(value: unknown): boolean {
  return getNumericValue(value) === MORTON_CODE_EXTREME_VALUE_INDICATOR;
}

export function extractSentinelBoundingBox(
  table: ArrowTable,
  xColumnName = 'x',
  yColumnName = 'y',
  mortonColumnName = MORTON_CODE_2D_COLUMN
): SpatialBounds | null {
  const xColumn = table.getChild(xColumnName);
  const yColumn = table.getChild(yColumnName);
  const mortonColumn = table.getChild(mortonColumnName);
  if (!xColumn || !yColumn || !mortonColumn) {
    return null;
  }

  const maxRows = Math.min(4, table.numRows);
  const xs: number[] = [];
  const ys: number[] = [];
  for (let i = 0; i < maxRows; i++) {
    if (!isMortonSentinelValue(mortonColumn.get(i))) {
      break;
    }
    const x = getNumericValue(xColumn.get(i));
    const y = getNumericValue(yColumn.get(i));
    if (x === null || y === null) {
      continue;
    }
    xs.push(x);
    ys.push(y);
  }
  if (xs.length < 2 || ys.length < 2) {
    return null;
  }
  return {
    minX: Math.min(...xs),
    minY: Math.min(...ys),
    maxX: Math.max(...xs),
    maxY: Math.max(...ys),
  };
}

export function featureCodeAllowSet(
  featureCodes: readonly number[] | undefined
): Set<number> | null {
  if (featureCodes === undefined) {
    return null;
  }
  return new Set(featureCodes);
}

export function rowMatchesFeatureCode(code: unknown, allowed: Set<number> | null): boolean {
  if (!allowed) {
    return true;
  }
  return typeof code === 'number' && Number.isFinite(code) && allowed.has(code);
}

/**
 * Future investigation: scan+compact loops below are hot paths for large
 * preloaded datasets. Candidates include WASM SIMD and WebGPU compute (e.g.
 * typegpu) for parallel index selection and column compaction. Worker offload
 * is the near-term fix; GPU/WASM is a follow-up benchmark task.
 *
 * FBO-based render caching for viewport-stable layers should plug into the
 * broader Render Stack compositing story (Group Entry, Viv/deck stacking) via
 * shared cache utilities — not a points-only optimization.
 */
export function filterColumnarByFeatureCodes(
  data: PointsColumnarData,
  featureCodes: readonly number[] | undefined,
  sourceFeatureCodes?: ArrayLike<number>
): PointsColumnarData {
  const allowedFeatureCodes = featureCodeAllowSet(featureCodes);
  if (allowedFeatureCodes === null || !sourceFeatureCodes) {
    // No filtering applied. Surface the aligned per-row codes when the source
    // provided them, so callers can build a `featureCode` render attribute.
    return sourceFeatureCodes ? { ...data, featureCodes: sourceFeatureCodes } : data;
  }
  if (allowedFeatureCodes.size === 0) {
    const axisCount = data.shape?.[0] ?? data.data.length;
    const empty = new Float32Array(0);
    const emptyData = axisCount >= 3 && data.data[2] ? [empty, empty, empty] : [empty, empty];
    return { shape: [axisCount, 0], data: emptyData, featureCodes: new Int32Array(0) };
  }

  const xs = data.data[0];
  const ys = data.data[1];
  const zs = data.data[2];
  const keep: number[] = [];
  const n = Math.min(xs?.length ?? 0, ys?.length ?? 0);
  for (let index = 0; index < n; index += 1) {
    if (!rowMatchesFeatureCode(sourceFeatureCodes[index], allowedFeatureCodes)) {
      continue;
    }
    keep.push(index);
  }

  if (keep.length === n) {
    return { ...data, featureCodes: sourceFeatureCodes };
  }

  const outX = new Float32Array(keep.length);
  const outY = new Float32Array(keep.length);
  const outZ = zs ? new Float32Array(keep.length) : undefined;
  const outCodes = new Int32Array(keep.length);
  for (let index = 0; index < keep.length; index += 1) {
    const sourceIndex = keep[index];
    outX[index] = xs[sourceIndex];
    outY[index] = ys[sourceIndex];
    if (outZ) {
      outZ[index] = zs[sourceIndex] ?? 0;
    }
    outCodes[index] = sourceFeatureCodes[sourceIndex];
  }

  return {
    shape: [outZ ? 3 : 2, keep.length],
    data: outZ ? [outX, outY, outZ] : [outX, outY],
    featureCodes: outCodes,
  };
}

export function filterPointsToBounds(
  data: PointsColumnarData,
  bounds: SpatialBounds,
  featureIndices?: ArrayLike<number>,
  featureCodes?: readonly number[],
  sourceFeatureCodes?: ArrayLike<number>
): PointsInBoundsResponse {
  const allowedFeatureCodes = featureCodeAllowSet(featureCodes);
  const xs = data.data[0];
  const ys = data.data[1];
  const zs = data.data[2];
  const keep: number[] = [];
  const n = Math.min(xs?.length ?? 0, ys?.length ?? 0);
  for (let i = 0; i < n; i++) {
    const x = xs[i];
    const y = ys[i];
    if (
      !Number.isFinite(x) ||
      !Number.isFinite(y) ||
      x < bounds.minX ||
      x > bounds.maxX ||
      y < bounds.minY ||
      y > bounds.maxY
    ) {
      continue;
    }
    if (
      allowedFeatureCodes &&
      !rowMatchesFeatureCode(sourceFeatureCodes?.[i], allowedFeatureCodes)
    ) {
      continue;
    }
    keep.push(i);
  }

  const outX = new Float32Array(keep.length);
  const outY = new Float32Array(keep.length);
  const outZ = zs ? new Float32Array(keep.length) : undefined;
  const outFeatureIndices = featureIndices ? new Uint32Array(keep.length) : undefined;
  for (let i = 0; i < keep.length; i++) {
    const sourceIndex = keep[i];
    outX[i] = xs[sourceIndex];
    outY[i] = ys[sourceIndex];
    if (outZ) {
      outZ[i] = zs?.[sourceIndex] ?? 0;
    }
    if (outFeatureIndices) {
      outFeatureIndices[i] = featureIndices?.[sourceIndex] ?? 0;
    }
  }

  return {
    data: outZ ? [outX, outY, outZ] : [outX, outY],
    shape: [outZ ? 3 : 2, keep.length],
    bounds,
    loadMode: 'full-filter',
    featureIndices: outFeatureIndices,
  };
}

export function boundsFromStoredPointsBounds(bounds: SpatialBounds): SpatialBounds {
  return bounds;
}
