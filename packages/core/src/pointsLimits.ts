/**
 * Row count above which a dataset is treated as "large" for **catalog strategy**
 * (route to the feature-column scan instead of a full-table decode). This is a
 * fixed heuristic, deliberately separate from the configurable memory cap below.
 */
export const POINTS_PRELOAD_MAX_ROWS = 4_000_000;

/**
 * Default in-memory row cap for the preloaded scatter (per-layer override via the
 * props panel — `PointsLayerConfig.pointsMemoryCap`). Kept at 4M: on an
 * UNINDEXED (dictionary-only, multipart) dataset the preload fetches WHOLE parts
 * and only stops after accumulating this many rows, so a larger default pulls ~2×
 * the bytes into the worker decode — which OOMs/hangs and falls back to a
 * main-thread decode that crashes the tab. Higher caps are safe on indexed
 * (row-group range-read) datasets and remain selectable in the panel for those.
 */
export const DEFAULT_POINTS_MEMORY_CAP = 4_000_000;

/** Default render row cap — points kept in memory may exceed this. Matches the
 * memory cap so, by default, everything loaded is drawn. */
export const DEFAULT_POINTS_RENDER_CAP = DEFAULT_POINTS_MEMORY_CAP;

export interface PointsColumnarLike {
  shape: number[];
  data: ArrayLike<number>[];
  pointCount?: number;
  /** Per-point feature code, aligned with {@link data}; truncated alongside it. */
  featureCodes?: ArrayLike<number>;
}

export function resolvePointsMemoryCap(configured?: number): number {
  if (configured !== undefined && Number.isFinite(configured) && configured > 0) {
    return Math.floor(configured);
  }
  return DEFAULT_POINTS_MEMORY_CAP;
}

export function resolvePointsRenderCap(configured?: number): number | undefined {
  if (configured === undefined) {
    return DEFAULT_POINTS_RENDER_CAP;
  }
  if (!Number.isFinite(configured) || configured <= 0) {
    return undefined;
  }
  return Math.floor(configured);
}

export function columnarPointCount(shape: number[], data: ArrayLike<number>[]): number {
  if (shape.length >= 2 && Number.isFinite(shape[1])) {
    return shape[1];
  }
  return data[0]?.length ?? shape[0] ?? 0;
}

/** Truncate a per-point feature-code array to `count`, preserving its element
 * type via `subarray` for typed arrays (zero-copy) and `slice` otherwise. */
function capFeatureCodes(
  featureCodes: ArrayLike<number> | undefined,
  count: number
): ArrayLike<number> | undefined {
  if (!featureCodes || featureCodes.length <= count) {
    return featureCodes;
  }
  if (ArrayBuffer.isView(featureCodes) && 'subarray' in featureCodes) {
    return (featureCodes as { subarray(begin: number, end: number): ArrayLike<number> }).subarray(
      0,
      count
    );
  }
  return Array.prototype.slice.call(featureCodes, 0, count) as ArrayLike<number>;
}

export function applyRenderCapToColumnar<T extends PointsColumnarLike>(
  batch: T,
  renderCap: number | undefined
): T {
  if (renderCap === undefined) {
    return batch;
  }
  const pointCount = batch.pointCount ?? columnarPointCount(batch.shape, batch.data);
  if (pointCount <= renderCap) {
    return batch;
  }
  const axisCount = batch.shape[0] ?? batch.data.length;
  const nextData = batch.data.map((column) => {
    if (column instanceof Float32Array) {
      return column.subarray(0, renderCap);
    }
    return Float32Array.from(column as ArrayLike<number>).subarray(0, renderCap);
  });
  const nextFeatureCodes = capFeatureCodes(batch.featureCodes, renderCap);
  return {
    ...batch,
    data: nextData,
    shape: [axisCount, renderCap],
    pointCount: renderCap,
    ...(nextFeatureCodes ? { featureCodes: nextFeatureCodes } : {}),
  };
}

export class PointsPreloadTooLargeError extends Error {
  readonly rowCount: number;
  readonly maxRows: number;

  constructor(rowCount: number, maxRows: number = POINTS_PRELOAD_MAX_ROWS) {
    super(
      `${rowCount.toLocaleString()} points exceeds the ${maxRows.toLocaleString()} preload limit — use a Morton-sorted element or tiled path`
    );
    this.name = 'PointsPreloadTooLargeError';
    this.rowCount = rowCount;
    this.maxRows = maxRows;
  }
}

export function preloadedColumnarPointCount(shape: number[], data: ArrayLike<number>[]): number {
  if (shape.length >= 2 && Number.isFinite(shape[1])) {
    return shape[1];
  }
  const fromData = data[0]?.length;
  if (typeof fromData === 'number') {
    return fromData;
  }
  return shape[0] ?? 0;
}

export function exceedsPointsPreloadLimit(rowCount: number): boolean {
  return rowCount > POINTS_PRELOAD_MAX_ROWS;
}

export function pointsPreloadTruncatedMessage(loadedCount: number, totalCount: number): string {
  return `Showing ${loadedCount.toLocaleString()} of ${totalCount.toLocaleString()} points (preload limit ${POINTS_PRELOAD_MAX_ROWS.toLocaleString()})`;
}

export function pointsFilteredMemoryCapMessage(
  loadedCount: number,
  memoryCap: number,
  scannedRows?: number
): string {
  const scanned =
    scannedRows !== undefined ? ` after scanning ${scannedRows.toLocaleString()} rows` : '';
  return `Showing ${loadedCount.toLocaleString()} matching points (memory cap ${memoryCap.toLocaleString()}${scanned})`;
}
