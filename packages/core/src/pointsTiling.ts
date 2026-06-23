import type { Table as ArrowTable } from 'apache-arrow';
import type { AxisAlignedBounds, PointsColumnarData } from './spatialViewFit.js';

export const MORTON_CODE_2D_COLUMN = 'morton_code_2d';
export const MORTON_CODE_EXTREME_VALUE_INDICATOR = 0;
export const MORTON_CODE_BITS_PER_AXIS = 16;
export const MORTON_CODE_VALUE_MAX = 2 ** MORTON_CODE_BITS_PER_AXIS - 1;

export type SpatialBounds = AxisAlignedBounds;

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

export function zcoverRectangle(
  rx0: number,
  ry0: number,
  rx1: number,
  ry1: number,
  bits = MORTON_CODE_BITS_PER_AXIS
): Array<[number, number]> {
  const maxCoord = 2 ** bits - 1;
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
    if (contained(xmin, ymin, xmax, ymax, x0, y0, x1, y1) || level === bits) {
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
    return data;
  }
  if (allowedFeatureCodes.size === 0) {
    const axisCount = data.shape?.[0] ?? data.data.length;
    const empty = new Float32Array(0);
    const emptyData = axisCount >= 3 && data.data[2] ? [empty, empty, empty] : [empty, empty];
    return { shape: [axisCount, 0], data: emptyData };
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
    return data;
  }

  const outX = new Float32Array(keep.length);
  const outY = new Float32Array(keep.length);
  const outZ = zs ? new Float32Array(keep.length) : undefined;
  for (let index = 0; index < keep.length; index += 1) {
    const sourceIndex = keep[index];
    outX[index] = xs[sourceIndex];
    outY[index] = ys[sourceIndex];
    if (outZ) {
      outZ[index] = zs[sourceIndex] ?? 0;
    }
  }

  return {
    shape: [outZ ? 3 : 2, keep.length],
    data: outZ ? [outX, outY, outZ] : [outX, outY],
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
