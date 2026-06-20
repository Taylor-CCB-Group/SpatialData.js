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
    };

export type PointsWorkerResponse =
  | {
      ok: true;
      result:
        | { kind: 'columnar'; shape: number[]; xs: Float32Array; ys: Float32Array; zs?: Float32Array }
        | { kind: 'parquetTable'; tableIpc: Uint8Array }
        | { kind: 'catalog'; catalog: PointsFeatureCatalog };
    }
  | { ok: false; error: string };

export type PointsWorkerMessage = {
  id: number;
} & (
  | { direction: 'request'; request: PointsWorkerRequest }
  | { direction: 'response'; response: PointsWorkerResponse }
);

export function columnarDataFromWorkerResult(result: Extract<
  PointsWorkerResponse,
  { ok: true }
>['result'] & { kind: 'columnar' }): PointsColumnarData {
  const data = result.zs ? [result.xs, result.ys, result.zs] : [result.xs, result.ys];
  return { shape: result.shape, data };
}
