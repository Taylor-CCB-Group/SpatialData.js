/** Maximum rows allowed for full-table points preload (canonical scatter path). */
export const POINTS_PRELOAD_MAX_ROWS = 4_000_000;

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
