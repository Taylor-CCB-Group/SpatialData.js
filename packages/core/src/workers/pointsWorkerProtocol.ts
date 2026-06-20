import type { PointsColumnarData } from '../spatialViewFit.js';
import type { PointsFeatureCatalog } from '../pointsTiling.js';

export type ParquetRowGroupBytesChunk = {
  schemaBytes: Uint8Array;
  rowGroupBytes: Uint8Array;
  rowGroupIndex: number;
  /** Dataset-wide row group index (for morton sentinel handling). */
  globalRowGroupIndex?: number;
};

export type ParquetWorkerPayload = {
  parts?: Uint8Array[];
  rowGroups?: ParquetRowGroupBytesChunk[];
};

export type PointsBounds = {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
};

export type PointsWorkerRequest =
  | {
      type: 'filterColumnarByFeatureCodes';
      xs: Float32Array;
      ys: Float32Array;
      zs?: Float32Array;
      /** Omitted = all features; empty = none. */
      featureCodes?: readonly number[];
      sourceFeatureCodes: ArrayLike<number>;
    }
  | {
      type: 'decodeParquetParts';
      parts: Uint8Array[];
      columns?: string[];
      /** When set, decode stops after this many rows (across parts). */
      maxRows?: number;
    }
  | {
      type: 'buildFeatureCatalog';
      featureKey: string;
      tableIpc: Uint8Array;
    }
  | {
      type: 'decodeParquetRowFeatureCodes';
      parts?: Uint8Array[];
      rowGroups?: ParquetRowGroupBytesChunk[];
      columns: string[];
      maxRows?: number;
      featureKey: string;
      featureCodeColumnName?: string;
      /** Serialized catalog for dict-only elements (no *_codes column). */
      featureCodeEntries?: ReadonlyArray<{ name: string; code: number }>;
    }
  | {
      type: 'countFeatureCodes';
      sourceFeatureCodes: ArrayLike<number>;
    }
  | {
      type: 'scanParquetFeatureCounts';
      parts?: Uint8Array[];
      rowGroups?: ParquetRowGroupBytesChunk[];
      featureKey: string;
      featureCodeColumnName?: string;
    }
  | {
      type: 'scanParquetFeatureCatalog';
      rowGroups?: ParquetRowGroupBytesChunk[];
      parts: Uint8Array[];
      columns: string[];
      featureKey: string;
      featureCodeColumnName?: string;
      skipMortonSentinels?: boolean;
    }
  | {
      type: 'decodeParquetGeometryCapped';
      parts?: Uint8Array[];
      rowGroups?: ParquetRowGroupBytesChunk[];
      axisNames: string[];
      columns: string[];
      maxRows: number;
      featureKey?: string;
      featureCodeColumnName?: string;
      featureCodeEntries?: ReadonlyArray<{ name: string; code: number }>;
    }
  | {
      type: 'scanParquetByFeatureCodes';
      parts?: Uint8Array[];
      rowGroups?: ParquetRowGroupBytesChunk[];
      axisNames: string[];
      featureKey: string;
      featureCodeColumnName?: string;
      featureCodes: readonly number[];
      memoryCap: number;
    }
  | {
      type: 'scanMortonRowGroupsInBounds';
      rowGroups: ParquetRowGroupBytesChunk[];
      bounds: PointsBounds;
      axisNames: string[];
      mortonCodeColumnName: string;
      featureCodeColumnName?: string;
      featureCodes?: readonly number[];
    };

export type PointsWorkerColumnarResult = {
  kind: 'columnar';
  shape: number[];
  xs: Float32Array;
  ys: Float32Array;
  zs?: Float32Array;
  featureCodes?: Int32Array;
};

export type PointsWorkerScanResult = Omit<PointsWorkerColumnarResult, 'kind' | 'featureCodes'> & {
  kind: 'columnarScan';
  matchedRows: number;
  scannedRows: number;
};

export type PointsWorkerResponse =
  | {
      ok: true;
      result:
        | PointsWorkerColumnarResult
        | PointsWorkerScanResult
        | { kind: 'parquetTable'; tableIpc: Uint8Array }
        | { kind: 'catalog'; catalog: PointsFeatureCatalog }
        | { kind: 'rowFeatureCodes'; codes: Int32Array; numRows: number }
        | { kind: 'featureCounts'; codes: Int32Array; counts: Uint32Array };
    }
  | { ok: false; error: string };

export type PointsWorkerMessage = {
  id: number;
} & (
  | { direction: 'request'; request: PointsWorkerRequest }
  | { direction: 'response'; response: PointsWorkerResponse }
);

export function columnarDataFromWorkerResult(
  result: PointsWorkerColumnarResult | PointsWorkerScanResult
): PointsColumnarData {
  const data = result.zs ? [result.xs, result.ys, result.zs] : [result.xs, result.ys];
  return { shape: result.shape, data };
}
