import type { PointsFeatureCatalog } from '../pointsTiling.js';
import type { TessellatedPolygons } from '../shapesPolygonTessellate.js';
import type { PointsColumnarData } from '../spatialViewFit.js';

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

export type ParquetWorkerRequest =
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
      type: 'decodeGeometryWithFeatures';
      parts?: Uint8Array[];
      rowGroups?: ParquetRowGroupBytesChunk[];
      axisNames: string[];
      /** Projected columns: axes + feature key (+ code column when present). */
      columns: string[];
      maxRows?: number;
      featureKey: string;
      featureCodeColumnName?: string;
    }
  | {
      type: 'scanParquetByFeatureCodes';
      parts?: Uint8Array[];
      rowGroups?: ParquetRowGroupBytesChunk[];
      /**
       * Stream variant: fetch and decode only the projected columns from this URL,
       * in the worker, instead of the caller shipping whole row-group BYTES.
       *
       * `parts`/`rowGroups` carry every column of a row group, because
       * parquet-wasm cannot fetch individual column chunks; `ParquetFile.stream`
       * issues its own ranged fetches per column chunk, so the projection reaches
       * the network. The caller decides whether the URL is servable (see
       * `canStreamMatchingScan`) and passes a row-group window per request so
       * progress stays granular without the protocol needing streamed responses.
       */
      streamUrl?: string;
      streamRowGroups?: number[];
      /** Projected columns for the stream variant: axes + the feature column. */
      streamColumns?: string[];
      axisNames: string[];
      featureKey: string;
      featureCodeColumnName?: string;
      featureCodes: readonly number[];
      memoryCap: number;
      /** Authoritative name→code map for dict-only elements (no *_codes column),
       * so the scan resolves each row's feature_name to the same code space the
       * selection was made in. Absent when a file-backed code column is present. */
      featureCodeEntries?: ReadonlyArray<{ name: string; code: number }>;
    }
  | {
      type: 'scanMortonRowGroupsInBounds';
      rowGroups: ParquetRowGroupBytesChunk[];
      bounds: PointsBounds;
      axisNames: string[];
      mortonCodeColumnName: string;
      featureCodeColumnName?: string;
      featureCodes?: readonly number[];
    }
  | {
      // Shapes geometry decode. The parquet worker is host to this too — see
      // `shapesGeometryDecode.ts`. If this generality holds the worker should be
      // renamed to a `parquet-worker`; deferred to avoid churning the points
      // worktree twice.
      type: 'decodeShapesGeometry';
      parts: Uint8Array[];
      geometryColumnName: string;
      geometryKind: 'polygon' | 'circle' | 'point';
    };

export type ParquetWorkerColumnarResult = {
  kind: 'columnar';
  shape: number[];
  xs: Float32Array;
  ys: Float32Array;
  zs?: Float32Array;
  featureCodes?: Int32Array;
};

export type ParquetWorkerScanResult = Omit<ParquetWorkerColumnarResult, 'kind'> & {
  kind: 'columnarScan';
  matchedRows: number;
  scannedRows: number;
};

export type ParquetWorkerResponse =
  | {
      ok: true;
      result:
        | ParquetWorkerColumnarResult
        | ParquetWorkerScanResult
        | {
            kind: 'geometryWithFeatures';
            shape: number[];
            xs: Float32Array;
            ys: Float32Array;
            zs?: Float32Array;
            featureCodes?: Int32Array;
            featureCatalog?: PointsFeatureCatalog;
          }
        | { kind: 'parquetTable'; tableIpc: Uint8Array }
        | { kind: 'catalog'; catalog: PointsFeatureCatalog }
        | { kind: 'rowFeatureCodes'; codes: Int32Array; numRows: number }
        | { kind: 'featureCounts'; codes: Int32Array; counts: Uint32Array }
        | {
            kind: 'shapesGeometryPolygon';
            positions: Float32Array;
            startIndices: Int32Array;
            featureCount: number;
            /** Vertex-pulling render topology, tessellated in the worker. */
            tessellation?: TessellatedPolygons;
          }
        | { kind: 'shapesGeometryPoint'; xs: Float32Array; ys: Float32Array; featureCount: number };
    }
  | { ok: false; error: string };

export type ParquetWorkerMessage = {
  id: number;
} & (
  | { direction: 'request'; request: ParquetWorkerRequest }
  | { direction: 'response'; response: ParquetWorkerResponse }
);

export function columnarDataFromWorkerResult(
  result: ParquetWorkerColumnarResult | ParquetWorkerScanResult
): PointsColumnarData {
  const data = result.zs ? [result.xs, result.ys, result.zs] : [result.xs, result.ys];
  const featureCodes = 'featureCodes' in result ? result.featureCodes : undefined;
  return { shape: result.shape, data, ...(featureCodes ? { featureCodes } : {}) };
}
