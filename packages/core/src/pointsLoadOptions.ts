export interface PointsLoadProgress {
  scannedRows: number;
  matchedRows: number;
  partIndex: number;
  partCount: number;
}

export interface PointsLoadOptions {
  /** Max rows to retain in memory (unfiltered cap or filtered match cap). */
  memoryCap?: number;
  /** When set, scan the dataset for matching features instead of capping raw rows first. */
  featureCodes?: readonly number[];
  /** Progress callback for filtered scans (main thread). */
  onProgress?: (progress: PointsLoadProgress) => void;
  /**
   * When true with {@link featureCodes}, scan the full dataset for matches (slow).
   * Default UI uses in-memory runtime filtering instead.
   */
  fullDatasetFeatureScan?: boolean;
}

export interface PointsLoadResult {
  shape: number[];
  data: ArrayLike<number>[];
  featureCodes?: ArrayLike<number>;
  totalRowCount?: number;
  preloadTruncated?: boolean;
  /** Rows scanned when loading with an active feature filter. */
  scannedRowCount?: number;
  filterActive?: boolean;
}
