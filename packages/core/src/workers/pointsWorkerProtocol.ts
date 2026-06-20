import type { PointsColumnarData } from '../spatialViewFit.js';
import type { PointsFeatureCatalog } from '../pointsTiling.js';

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
      parts: Uint8Array[];
      columns: string[];
      maxRows?: number;
      featureKey: string;
      featureCodeColumnName?: string;
    }
  | {
      type: 'countFeatureCodes';
      sourceFeatureCodes: ArrayLike<number>;
    }
  | {
      type: 'scanParquetFeatureCounts';
      parts: Uint8Array[];
      featureKey: string;
      featureCodeColumnName?: string;
    }
  | {
      type: 'scanParquetByFeatureCodes';
      parts: Uint8Array[];
      axisNames: string[];
      featureKey: string;
      featureCodeColumnName?: string;
      featureCodes: readonly number[];
      memoryCap: number;
    };

export type PointsWorkerColumnarResult = {
  kind: 'columnar';
  shape: number[];
  xs: Float32Array;
  ys: Float32Array;
  zs?: Float32Array;
};

export type PointsWorkerScanResult = Omit<PointsWorkerColumnarResult, 'kind'> & {
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
