import type { PointsFeatureCatalog } from './pointsTiling.js';

export interface PointsLoadProgress {
  scannedRows: number;
  matchedRows: number;
  partIndex: number;
  partCount: number;
  partialResult: PointsLoadResult;
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
  /**
   * Read the feature column alongside the geometry in the same (projected,
   * capped) preload, and derive per-row feature codes + the feature catalog from
   * that one decode. Lets the feature filter work with no separate, blocking
   * catalog/row-code load at filter time. The catalog reflects the *resident*
   * (preloaded) rows — i.e. the features present in the points actually drawn.
   */
  includeFeatureCodes?: boolean;
  /**
   * Cancels a superseded load (e.g. the memory cap changed mid-load). Checked at
   * the load boundaries — notably BEFORE the main-thread fallback decode — so an
   * aborted load bails instead of running an expensive fallback to completion.
   */
  signal?: AbortSignal;
}

export interface PointsLoadResult {
  shape: number[];
  data: ArrayLike<number>[];
  featureCodes?: ArrayLike<number>;
  /** Catalog derived from the resident feature column (present when the load was
   * requested with {@link PointsLoadOptions.includeFeatureCodes}). */
  featureCatalog?: PointsFeatureCatalog;
  /** True when the element has a file-backed feature code column (e.g.
   * `feature_name_codes`) — a real feature index whose codes are globally
   * authoritative. False/absent for dictionary-only feature columns, where codes
   * are assigned by the app and are only stable within a single catalog build.
   * Present when the load was requested with
   * {@link PointsLoadOptions.includeFeatureCodes}. Gates the whole-dataset
   * feature-index scan (only worthwhile / correct when codes are authoritative). */
  hasFeatureCodeColumn?: boolean;
  totalRowCount?: number;
  preloadTruncated?: boolean;
  /** Rows scanned when loading with an active feature filter. */
  scannedRowCount?: number;
  filterActive?: boolean;
}
