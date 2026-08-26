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
      /**
       * Progressive geometry+colour preload, streamed END TO END in the worker.
       *
       * The worker opens each part with `ParquetFile.fromUrl` and issues its own
       * ranged fetches, so the caller ships URLs rather than bytes and never
       * decodes. Batches come back as {@link ParquetWorkerStreamChunk} messages
       * under this request's id, followed by one terminal response — the only
       * request type in this protocol with more than one message per id.
       *
       * The caller resolves the URLs and vouches for the server (see
       * `canStreamParquetByUrl` / `serverSupportsStreamingRanges`); the worker
       * assumes both and fails the request if a URL will not open.
       */
      type: 'streamGeometryWithFeatures';
      /** Absolute, range-readable URLs, in dataset part order. */
      partUrls: string[];
      axisNames: string[];
      featureKey: string;
      /** Stop once this many rows have been emitted, across all parts. */
      maxRows: number;
      /** Rows per emitted batch; the caller's `PRELOAD_STREAM_BATCH_ROWS`. */
      batchSize: number;
    }
  | {
      /**
       * Stop a `streamGeometryWithFeatures` early — a superseded load, or a
       * client-side timeout. Without it the worker keeps fetching a payload
       * nobody will read.
       *
       * Carries the id of the stream to cancel, not its own: cancel travels as an
       * ordinary request with a fresh id so it settles through the same path.
       */
      type: 'cancelParquetStream';
      streamRequestId: number;
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

/**
 * One decoded batch of a {@link ParquetWorkerRequest} of type
 * `streamGeometryWithFeatures`, posted while the request is still running.
 *
 * Deliberately a DELTA, not a snapshot: the accumulator lives on the main thread
 * (it owns the buffers the renderer reads), so each batch carries only its own
 * rows and only the catalog entries this batch was the first to see. Posting a
 * growing snapshot instead would re-copy the whole preload once per batch —
 * O(rows x batches) transfer for a 4M-row element.
 *
 * `axes` is one array per axis, in `axisNames` order, each of length `rows`; the
 * buffers are transferred, so the worker must not retain them.
 */
export type ParquetWorkerStreamChunk = {
  kind: 'geometryWithFeaturesBatch';
  /** Index of the part this batch came from, and how many parts there are. */
  partIndex: number;
  partCount: number;
  /** Rows in this batch — the length of every array below except the tallies. */
  rows: number;
  axes: Float32Array[];
  featureCodes: Int32Array;
  /**
   * Catalog entries first assigned in this batch. Empty once the stream has seen
   * every feature, which for a dictionary column is usually after batch one.
   */
  newFeatures: ReadonlyArray<{ code: number; name: string }>;
  /**
   * Per-feature row tallies FOR THIS BATCH, as parallel arrays over the codes the
   * batch actually used. The main thread adds them into its running totals; a
   * whole-tally snapshot per batch would be O(features x batches).
   */
  tallyCodes: Int32Array;
  tallyCounts: Uint32Array;
};

/** Buffers to transfer with a stream chunk. */
export function transferablesForStreamChunk(chunk: ParquetWorkerStreamChunk): Transferable[] {
  return [
    ...chunk.axes.map((axis) => axis.buffer),
    chunk.featureCodes.buffer,
    chunk.tallyCodes.buffer,
    chunk.tallyCounts.buffer,
  ];
}

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
        | {
            /**
             * Terminal message of a `streamGeometryWithFeatures` request: the
             * rows are already on the main thread, so this only reports how the
             * stream ended.
             */
            kind: 'geometryWithFeaturesStreamEnd';
            /** Total rows emitted across every batch of this stream. */
            rows: number;
            /**
             * False when a part's projection came back without the feature
             * column, which is the one case where the emitted rows are NOT
             * coloured and the caller has to settle codes separately.
             */
            sawFeatureColumn: boolean;
          }
        | { kind: 'streamCancelled' }
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
  /**
   * An INTERIM message: more may follow under this id, and a `response` is still
   * to come. Only `streamGeometryWithFeatures` produces these — every other
   * request type posts exactly one `response` and nothing else, which is why a
   * reader that ignores this direction still behaves correctly for them.
   */
  | { direction: 'stream'; chunk: ParquetWorkerStreamChunk }
);

export function columnarDataFromWorkerResult(
  result: ParquetWorkerColumnarResult | ParquetWorkerScanResult
): PointsColumnarData {
  const data = result.zs ? [result.xs, result.ys, result.zs] : [result.xs, result.ys];
  const featureCodes = 'featureCodes' in result ? result.featureCodes : undefined;
  return { shape: result.shape, data, ...(featureCodes ? { featureCodes } : {}) };
}
