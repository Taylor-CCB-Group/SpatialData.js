import { decodeIntStat, parseParquetFileMetaData } from '../parquetFooterStats.js';
import {
  buildFeatureCatalogFromColumns,
  featureCodeMapFromCatalog,
  mergeFeatureCountsIntoCatalog,
  resolveRowFeatureCodesFromTable,
} from '../pointsFeatures.js';
import { exceedsPointsPreloadLimit, resolvePointsMemoryCap } from '../pointsLimits.js';
import type {
  PointsLoadOptions,
  PointsLoadProgress,
  PointsLoadResult,
} from '../pointsLoadOptions.js';
import { basename } from '../Vutils';
import {
  decodeGeometryWithFeaturesInWorker,
  decodeParquetGeometryCappedInWorker,
  decodeParquetRowFeatureCodesInWorker,
  ensurePointsWorker,
  isPointsWorkerEnabled,
  scanMortonRowGroupsInBoundsInWorker,
  scanParquetByFeatureCodesInWorker,
  scanParquetFeatureCatalogInWorker,
  scanParquetFeatureCountsInWorker,
} from '../workers/pointsWorkerClient.js';

interface ColumnarPointsChunk {
  shape: number[];
  data: ArrayLike<number>[];
  featureCodes?: ArrayLike<number>;
}

/** Inclusive `[min, max]` code range a row group's feature-code column spans. */
interface FeatureCodeExtent {
  min: number;
  max: number;
}

/**
 * Per-row-group `[min, max]` for the feature-code column, parsed from each part's
 * footer statistics and flattened into global row-group order. Powers the
 * feature-primary index: a row group whose range can't contain any selected code
 * is skipped without fetching it. Returns `[]` to signal "stats unavailable —
 * scan everything" (footer parse failed, a column had no statistics, or the
 * flattened count didn't match the dataset's row-group count). An entry is `null`
 * when that specific row group lacks usable stats, so it is scanned rather than
 * wrongly skipped.
 */
function rowGroupFeatureCodeExtents(
  parts: readonly { schemaBytes: Uint8Array }[],
  featureCodeColumnName: string,
  expectedRowGroupCount: number
): Array<FeatureCodeExtent | null> {
  const extents: Array<FeatureCodeExtent | null> = [];
  for (const part of parts) {
    // `schemaBytes` is the parquet footer: FileMetaData thrift + trailing 4-byte
    // length + "PAR1". Strip the trailing 8 to get the FileMetaData for the parser.
    if (part.schemaBytes.length <= 8) {
      return [];
    }
    const metaBytes = part.schemaBytes.subarray(0, part.schemaBytes.length - 8);
    let footer: ReturnType<typeof parseParquetFileMetaData>;
    try {
      footer = parseParquetFileMetaData(metaBytes);
    } catch {
      return [];
    }
    for (const rowGroup of footer.rowGroups) {
      const column = rowGroup.columns.find((col) => col.path === featureCodeColumnName);
      if (!column) {
        extents.push(null);
        continue;
      }
      const min = decodeIntStat(column.minValue, column.physicalType);
      const max = decodeIntStat(column.maxValue, column.physicalType);
      extents.push(min !== null && max !== null ? { min, max } : null);
    }
  }
  return extents.length === expectedRowGroupCount ? extents : [];
}

/** Whether a row group's code range can contain any selected code. `null` extent
 * (missing stats) is treated as "might match" so it is scanned, not skipped. */
function extentMayContainSelectedCodes(
  extent: FeatureCodeExtent | null,
  selectedMin: number,
  selectedMax: number
): boolean {
  if (!extent) {
    return true;
  }
  return extent.max >= selectedMin && extent.min <= selectedMax;
}

function emptyFilteredPointsResult(axisNames: string[], totalRowCount: number): PointsLoadResult {
  const hasZ = axisNames.includes('z');
  const empty = new Float32Array(0);
  const data = hasZ ? [empty, empty, empty] : [empty, empty];
  return {
    shape: [data.length, 0],
    data,
    totalRowCount,
    scannedRowCount: 0,
    filterActive: true,
  };
}

function toColumnarPointsChunk(
  data: { shape?: number[]; data: ArrayLike<number>[]; featureCodes?: ArrayLike<number> },
  axisCount: number
): ColumnarPointsChunk {
  const rowCount = data.shape?.[1] ?? data.data[0]?.length ?? 0;
  return {
    shape: data.shape ?? [axisCount, rowCount],
    data: data.data,
    ...(data.featureCodes ? { featureCodes: data.featureCodes } : {}),
  };
}

function concatColumnarPointChunks(chunks: ColumnarPointsChunk[]): ColumnarPointsChunk {
  if (chunks.length === 0) {
    const empty = new Float32Array(0);
    return { shape: [2, 0], data: [empty, empty] };
  }
  const axisCount = chunks[0].shape[0] ?? chunks[0].data.length;
  const totalRows = chunks.reduce(
    (sum, chunk) => sum + (chunk.shape[1] ?? chunk.data[0]?.length ?? 0),
    0
  );
  const data = Array.from({ length: axisCount }, (_, axisIndex) => {
    const merged = new Float32Array(totalRows);
    let offset = 0;
    for (const chunk of chunks) {
      const column = chunk.data[axisIndex];
      if (!column) {
        continue;
      }
      const values = column instanceof Float32Array ? column : Float32Array.from(column);
      merged.set(values, offset);
      offset += values.length;
    }
    return merged;
  });
  // Concatenate per-point feature codes in lockstep when every chunk carries
  // them (they do when the source resolved a feature key).
  let featureCodes: Int32Array | undefined;
  if (chunks.every((chunk) => chunk.featureCodes)) {
    featureCodes = new Int32Array(totalRows);
    let offset = 0;
    for (const chunk of chunks) {
      const codes = chunk.featureCodes as ArrayLike<number>;
      const values = codes instanceof Int32Array ? codes : Int32Array.from(codes);
      featureCodes.set(values, offset);
      offset += values.length;
    }
  }
  return { shape: [axisCount, totalRows], data, ...(featureCodes ? { featureCodes } : {}) };
}

/**
 * Build the per-chunk streaming payload for a progressive points scan: the
 * latest decoded chunk plus a `progress` whose `partialResult` is the GROWING
 * buffer of everything matched so far (all `accumulatedChunks` concatenated), so
 * a consumer can render points that accumulate rather than flash past.
 *
 * Shared by both scan branches (row-group / parts) here, and intended for reuse
 * by other `VPointsSource` scans that want progressive display. The buffer is
 * re-concatenated each chunk, so total copy work grows with the square of the
 * *chunk count* — negligible in practice (a feature-indexed scan touches only a
 * handful of row groups; the parts path is bounded by part count). Only worth
 * replacing with a preallocated append buffer if a scan ever yields very many
 * small chunks.
 */
function pointsScanChunkProgress(
  accumulatedChunks: ColumnarPointsChunk[],
  latest: ColumnarPointsChunk,
  counts: {
    scannedRows: number;
    matchedRows: number;
    totalRowCount: number;
    memoryCap: number;
    partIndex: number;
    partCount: number;
  }
): { chunk: ColumnarPointsChunk; progress: PointsLoadProgress } {
  const buffer = concatColumnarPointChunks(accumulatedChunks);
  const partialResult: PointsLoadResult = {
    shape: buffer.shape,
    data: buffer.data,
    ...(buffer.featureCodes ? { featureCodes: buffer.featureCodes } : {}),
    totalRowCount: counts.totalRowCount,
    scannedRowCount: counts.scannedRows,
    filterActive: true,
    preloadTruncated: counts.matchedRows >= counts.memoryCap,
  };
  return {
    chunk: latest,
    progress: {
      scannedRows: counts.scannedRows,
      matchedRows: counts.matchedRows,
      partIndex: counts.partIndex,
      partCount: counts.partCount,
      partialResult,
    },
  };
}

import {
  extractSentinelBoundingBox,
  featureCodeAllowSet,
  filterPointsToBounds,
  MORTON_CODE_2D_COLUMN,
  mortonIntervalsForBounds,
  type PointsFeatureCatalog,
  type PointsInBoundsOptions,
  type PointsInBoundsResponse,
  type PointsTilingMetadata,
} from '../pointsTiling.js';
import type { Axis } from '../schemas';
// import { normalizeAxes } from '@vitessce/spatial-utils';
import SpatialDataTableSource from './VTableSource';

// TODO: is this needed?
// In the spatialdata metadata the axis name/type/unit info are also listed in
// coordinateTransformations[].input|output.axes[] entries.
export function normalizeAxes(axes: Axis[]) {
  // Normalize axes to OME-NGFF v0.4 format.
  return axes.map((axisInfo) => {
    if (typeof axisInfo === 'string') {
      // If the axis is a string, assume it is a name and set type to 'space'.
      return { name: axisInfo, type: 'space' };
    }
    return axisInfo;
  });
}

/*
 * Notes from https://spatialdata.scverse.org/en/stable/design_doc.html#points as of July 18, 2025:
 *
 * > This representation is still under discussion and it might change...
 * > Coordinates of points for single molecule data.
 * > Each observation is a point, and might have additional information
 * > (intensity etc.).
 * > Current implementation represent points as a Parquet file and a
 * > dask.dataframe.DataFrame in memory.
 * > The requirements are the following:
 * > - The table MUST contains axis name to represent the axes.
 * >     - If it’s 2D, the axes should be ["x","y"].
 * >     - If it’s 3D, the axes should be ["x","y","z"].
 * > - It MUST also contains coordinates transformations in
 * >   dask.dataframe.DataFrame().attrs["transform"].
 * > Additional information is stored in
 * > dask.dataframe.DataFrame().attrs["spatialdata_attrs"]
 * > - It MAY also contains "feature_key", that is, the column name of
 * >   the table that refers to the features.
 * >     - This Series MAY be of type pandas.Categorical.
 * > - It MAY contains additional information in
 * >   dask.dataframe.DataFrame().attrs["spatialdata_attrs"], specifically:
 * >     - "instance_key": the column name of the table where unique
 * >       instance ids that this point refers to are stored, if available.
 */

const pointsElementRegex = /^points\/([^/]*)$/;
const pointsSubElementRegex = /^points\/([^/]*)\/(.*)$/;

/**
 * Rows per batch when streaming the feature column for the catalog.
 *
 * Larger than the upstream 1024 default: each batch costs an IPC round-trip, and
 * at 1024 that overhead dominated (60 batches for 60k rows). 16k keeps partials
 * frequent enough to look progressive while amortising the per-batch cost.
 */
const FEATURE_STREAM_BATCH_ROWS = 16_384;

function getPointsElementPath(arrPath?: string) {
  if (arrPath) {
    const matches = arrPath.match(pointsSubElementRegex);
    if (matches && matches.length === 3) {
      return `points/${matches[1]}`;
    }
    const elementMatches = arrPath.match(pointsElementRegex);
    if (elementMatches && elementMatches.length === 2) {
      return `points/${elementMatches[1]}`;
    }
  }
  return ''; // TODO: throw an error?
}

function getParquetPath(arrPath?: string) {
  const elementPrefix = getPointsElementPath(arrPath);
  if (elementPrefix.startsWith('points/')) {
    return `${elementPrefix}/points.parquet`;
  }
  throw new Error(`Cannot determine parquet path for points array path: ${arrPath}`);
}

function arrowSchemaFieldNames(table: { schema: { fields?: Array<{ name?: unknown }> } } | null) {
  return (
    table?.schema.fields?.flatMap((field) =>
      typeof field.name === 'string' ? [field.name] : []
    ) ?? []
  );
}

function selectFeatureCodeColumn(fields: string[], featureKey: string | undefined) {
  const candidates = [
    featureKey ? `${featureKey}_codes` : undefined,
    'feature_name_codes',
    'feature_index',
  ].filter((value): value is string => typeof value === 'string');
  return candidates.find((candidate) => fields.includes(candidate));
}

function checkAbort(signal?: AbortSignal) {
  if (signal?.aborted) {
    throw new DOMException('The operation was aborted.', 'AbortError');
  }
}

function rowGroupCountForIndex(metadata: PointsTilingMetadata, rowGroupIndex: number) {
  if (rowGroupIndex < 0 || rowGroupIndex >= metadata.totalRowGroups) {
    return 0;
  }
  return metadata.rowGroupRowCounts?.[rowGroupIndex] ?? metadata.maxRowsPerGroup;
}

export default class SpatialDataPointsSource extends SpatialDataTableSource {
  private readonly pointTilingMetadataCache = new Map<
    string,
    Promise<PointsTilingMetadata | null>
  >();

  /**
   *
   * @param path A path to within shapes.
   * @returns The format version.
   */
  async getPointsFormatVersion(path: string): Promise<'0.1'> {
    const zattrs = await this.loadSpatialDataElementAttrs(path);
    const formatVersion = zattrs.spatialdata_attrs.version;
    const encodingType = zattrs['encoding-type'];
    if (encodingType === 'ngff:points' && !(formatVersion === '0.1')) {
      throw new Error(`Unexpected version for points spatialdata_attrs: ${formatVersion}`);
    }
    return formatVersion;
  }

  /**
   * Class method for loading general numeric arrays.
   * @param path A string like obsm.X_pca.
   * @returns {Promise<Chunk<any>>} A promise for a zarr array containing the data.
   */
  async loadNumeric(path: string) {
    const parquetPath = getParquetPath(path);
    const columnName = basename(path);
    const columns = [columnName];
    const arrowTable = await this.loadParquetTable(parquetPath, columns);
    const columnArr = arrowTable.getChild(columnName)?.toArray();
    return {
      shape: [columnArr.length],
      // TODO: support other kinds of TypedArrays via @vitessce/arrow-utils.
      data: columnArr,
      stride: [1],
    };
  }

  /**
   *
   * @param elementPath
   * @returns {Promise<Array<any>|null>}
   */
  async loadPointsIndex(elementPath: string) {
    const parquetPath = getParquetPath(elementPath);
    const indexColumn = await this.loadParquetTableIndex(parquetPath);
    if (indexColumn) {
      return indexColumn.toArray();
    }
    return null;
  }

  /**
   *
   * @param elementPath The path to the points element,
   * like "points/element_name".
   * @returns {Promise<{
   *  data: [ZarrTypedArray<any>, ZarrTypedArray<any>],
   *  shape: [number, number],
   * }>} A promise for a zarr array containing the data.
   */
  /**
   * Progressive geometry preload (D3): decode the capped window ONE ROW GROUP AT A
   * TIME, emitting a growing partial after each, so points appear while the rest
   * decodes instead of only after a single multi-second whole-part decode. This is
   * the fix for "wild-type transcripts show nothing for ages".
   *
   * Only the axes (and an authoritative INTEGER feature-code column, when the
   * dataset has one) are read here. That restriction is the whole design:
   * `readParquetRowGroup` mis-decodes DICTIONARY-encoded columns, so the
   * `feature_name` dict column can never be read this way — but plain float axes and
   * a plain int code column are safe. So a dataset WITH a code column streams fully
   * COLOURED from the first chunk, while a dict-only dataset streams flat and has
   * its codes/catalog settled afterwards by the one-shot whole-part decode.
   *
   * The accumulator is preallocated at `maxRows` and appended at an offset cursor;
   * each partial exposes the filled prefix as `subarray` VIEWS, so a progress tick
   * is free — no re-concatenation (contrast {@link pointsScanChunkProgress}, which
   * re-copies the whole buffer per chunk and is O(chunks²)).
   *
   * Returns null when streaming isn't possible (no dataset metadata, no range
   * reads, worker disabled, nothing decoded) so the caller falls back to one-shot.
   */
  private async streamPointsGeometryByRowGroup(
    parquetPath: string,
    options: {
      axisNames: string[];
      columns: string[];
      maxRows: number;
      totalRowCount: number;
      preloadTruncated: boolean;
      /** Required alongside {@link featureCodeColumnName} for the decode to emit
       * per-row codes at all — the worker gates code extraction on `featureKey`. */
      featureKey?: string;
      featureCodeColumnName?: string;
      onProgress?: (progress: PointsLoadProgress) => void;
      signal?: AbortSignal;
    }
  ): Promise<PointsLoadResult | null> {
    const dataset = await this.loadParquetDatasetMetadata(parquetPath);
    if (!dataset || dataset.totalNumRowGroups <= 0) {
      return null;
    }
    const { axisNames, maxRows, featureCodeColumnName } = options;
    const axisCount = axisNames.length;
    const axisBuffers = Array.from({ length: axisCount }, () => new Float32Array(maxRows));
    const codeBuffer = featureCodeColumnName ? new Int32Array(maxRows) : undefined;
    let filled = 0;
    // Goes false the moment any chunk fails to supply one code PER ROW. Observed in
    // practice: a per-row-group read of the code column can come back with just the
    // column's distinct values (e.g. 4 codes for a 100k-row group in a feature-sorted
    // file), because the row-group path mis-handles dictionary encoding — the same
    // constraint that keeps `feature_name` off this path. Once false the stream
    // publishes NO codes, so the caller falls through to the one-shot decode.
    let codesComplete = codeBuffer !== undefined;
    // Running per-feature tally. Free in I/O terms — the codes are already decoded —
    // and O(rows) once overall, so a panel can show per-feature stats long before the
    // whole-dataset counts scan finishes. Counts cover the streamed prefix only.
    const codeCounts = new Map<number, number>();

    // Views over the filled prefix — no copy, so emitting a partial is O(1). The
    // tally is passed by reference and keeps growing; consumers read it per tick.
    const snapshot = (): PointsLoadResult => ({
      shape: [axisCount, filled] as [number, number],
      data: axisBuffers.map((buffer) => buffer.subarray(0, filled)),
      totalRowCount: options.totalRowCount,
      preloadTruncated: options.preloadTruncated,
      hasFeatureCodeColumn: featureCodeColumnName !== undefined,
      ...(codeBuffer && codesComplete
        ? { featureCodes: codeBuffer.subarray(0, filled), featureCodeCounts: new Map(codeCounts) }
        : {}),
    });

    for (let rowGroupIndex = 0; rowGroupIndex < dataset.totalNumRowGroups; rowGroupIndex += 1) {
      checkAbort(options.signal); // superseded → stop before the next range read
      if (filled >= maxRows) {
        break;
      }
      const chunk = await this.readParquetRowGroupBytesByGroupIndex(parquetPath, rowGroupIndex);
      if (!chunk) {
        return filled > 0 ? snapshot() : null;
      }
      const decoded = await decodeParquetGeometryCappedInWorker({
        rowGroups: [chunk],
        axisNames,
        columns: options.columns,
        maxRows: maxRows - filled,
        // BOTH are required: the worker gates code extraction on `featureKey`, and
        // `resolveRowFeatureCodesFromTable` then returns the code column directly —
        // it never touches the (unprojected, dict-encoded) name column. Passing only
        // `featureCodeColumnName` silently yields NO codes, which is a colourless
        // element rather than a loud failure.
        ...(featureCodeColumnName && options.featureKey
          ? { featureCodeColumnName, featureKey: options.featureKey }
          : {}),
      });
      if (!decoded) {
        // Worker unavailable: with nothing decoded yet the caller can still take the
        // one-shot path; mid-stream we keep what we have rather than discard it.
        return filled > 0 ? snapshot() : null;
      }
      const decodedRows = decoded.shape[1] ?? decoded.data[0]?.length ?? 0;
      const rows = Math.min(decodedRows, maxRows - filled);
      if (rows <= 0) {
        continue;
      }
      for (let axis = 0; axis < axisCount; axis += 1) {
        const column = decoded.data[axis];
        if (!column) {
          continue;
        }
        const values =
          column instanceof Float32Array
            ? column.subarray(0, rows)
            : Float32Array.from(Array.prototype.slice.call(column, 0, rows));
        axisBuffers[axis].set(values, filled);
      }
      if (codeBuffer) {
        // A SHORT codes array is unusable, not partially usable: writing it would
        // leave the remaining rows at 0 — a VALID feature code — so those points
        // would be confidently mis-coloured rather than left uncoloured. Demand one
        // code per row or discard codes for the whole stream.
        const chunkCodes = decoded.featureCodes;
        if (chunkCodes && chunkCodes.length >= rows) {
          codeBuffer.set(chunkCodes.subarray(0, rows), filled);
          // Tally this chunk while its codes are hot, rather than re-walking the
          // whole prefix on every progress tick.
          for (let row = 0; row < rows; row += 1) {
            const code = chunkCodes[row];
            codeCounts.set(code, (codeCounts.get(code) ?? 0) + 1);
          }
        } else {
          codesComplete = false;
        }
      }
      filled += rows;
      options.onProgress?.({
        // Unfiltered preload: every decoded row is kept, so scanned === matched.
        scannedRows: filled,
        matchedRows: filled,
        partIndex: rowGroupIndex,
        partCount: dataset.totalNumRowGroups,
        partialResult: snapshot(),
      });
    }
    return filled > 0 ? snapshot() : null;
  }

  async loadPoints(
    elementPath: string,
    options: PointsLoadOptions = {}
  ): Promise<PointsLoadResult> {
    checkAbort(options.signal);
    const memoryCap = resolvePointsMemoryCap(options.memoryCap);
    if (options.featureCodes !== undefined && options.fullDatasetFeatureScan === true) {
      return this.loadPointsMatchingFeatureCodes(elementPath, {
        memoryCap,
        featureCodes: options.featureCodes,
        onProgress: options.onProgress,
      });
    }

    const parquetPath = getParquetPath(elementPath);
    const zattrs = await this.loadSpatialDataElementAttrs(elementPath);
    const { axes } = zattrs;
    const normAxes = normalizeAxes(axes);
    const axisNames = normAxes.map((axis: { name: string }) => axis.name);
    const rowCount = await this.resolveParquetRowCount(parquetPath);
    const truncatePreload = rowCount > memoryCap;
    const maxRows = truncatePreload ? memoryCap : rowCount;
    const columnNames = [...axisNames];

    // Optionally read the feature column(s) in the same projected, capped preload
    // so the filter's catalog + per-row codes come from one decode — no separate
    // blocking load at filter time (PointsLoadOptions.includeFeatureCodes).
    const configuredFeatureKey = zattrs.spatialdata_attrs?.feature_key;
    const wantFeatures =
      options.includeFeatureCodes === true &&
      typeof configuredFeatureKey === 'string' &&
      configuredFeatureKey.length > 0;
    const featureKey = wantFeatures ? (configuredFeatureKey as string) : undefined;
    let featureCodeColumnName: string | undefined;
    if (featureKey) {
      const datasetMetadata = await this.loadParquetDatasetMetadata(parquetPath);
      const schemaTable = datasetMetadata ? null : await this.loadParquetSchemaTable(parquetPath);
      const fields = datasetMetadata?.schema?.fields
        ? datasetMetadata.schema.fields.flatMap((field) =>
            typeof field.name === 'string' ? [field.name] : []
          )
        : arrowSchemaFieldNames(schemaTable);
      featureCodeColumnName = selectFeatureCodeColumn(fields, featureKey);
      columnNames.push(featureKey);
      if (featureCodeColumnName) {
        columnNames.push(featureCodeColumnName);
      }
    }

    ensurePointsWorker();
    if (isPointsWorkerEnabled()) {
      // Progressive preload (D3), when the caller asked for progress and the store
      // supports row-group range reads. Streams the axes — plus an authoritative
      // integer code column when the dataset has one, so those datasets stream
      // COLOURED rather than colour-later.
      if (options.onProgress && (await this.canLoadParquetRowGroups())) {
        try {
          const streamed = await this.streamPointsGeometryByRowGroup(parquetPath, {
            axisNames,
            columns: [...axisNames, ...(featureCodeColumnName ? [featureCodeColumnName] : [])],
            maxRows,
            totalRowCount: rowCount,
            preloadTruncated: truncatePreload,
            ...(featureKey ? { featureKey } : {}),
            ...(featureCodeColumnName ? { featureCodeColumnName } : {}),
            onProgress: options.onProgress,
            ...(options.signal ? { signal: options.signal } : {}),
          });
          // The streamed batch is the FINAL result only when nothing more is needed
          // from the dictionary column: either the element has no feature key at all,
          // or an authoritative code column ACTUALLY produced per-row codes. Checking
          // `streamed.featureCodes` rather than merely "a code column exists" is
          // deliberate: if the codes ever fail to come back, we degrade to the slower
          // one-shot decode (correct, just not streamed) instead of settling a
          // permanently colourless batch — the failure mode this guard exists for.
          // A dict-only element always falls through, its early paint already banked.
          const streamedIsComplete =
            streamed !== null && (!featureKey || streamed.featureCodes !== undefined);
          if (streamedIsComplete) {
            return streamed;
          }
        } catch (error) {
          if (error instanceof DOMException && error.name === 'AbortError') {
            throw error;
          }
          console.warn(
            `Progressive points preload failed for ${elementPath}; falling back to a single decode.`,
            error
          );
        }
      }
      try {
        if (featureKey) {
          // Off-thread the codes-with-geometry decode: fetch whole row-group (or
          // part) bytes via async range reads, then decode geometry + per-row
          // codes + catalog in the worker so the CPU-heavy decode never blocks the
          // main thread. parquet-wasm cannot fetch individual column chunks, so we
          // still fetch all columns' bytes — see docs/parquet-wasm-limitations.md.
          const payload = await this.fetchParquetPayloadCapped(parquetPath, maxRows);
          const workerResult = payload
            ? await decodeGeometryWithFeaturesInWorker({
                ...payload,
                axisNames,
                columns: columnNames,
                maxRows,
                featureKey,
                featureCodeColumnName,
              })
            : null;
          if (workerResult) {
            return {
              shape: workerResult.shape as [number, number],
              data: workerResult.data,
              totalRowCount: rowCount,
              preloadTruncated: truncatePreload,
              hasFeatureCodeColumn: featureCodeColumnName !== undefined,
              ...(workerResult.featureCodes ? { featureCodes: workerResult.featureCodes } : {}),
              ...(workerResult.featureCatalog
                ? { featureCatalog: workerResult.featureCatalog }
                : {}),
            };
          }
        } else {
          const payload = await this.readParquetWorkerPayload(parquetPath, { maxRows });
          const workerGeometry = await decodeParquetGeometryCappedInWorker({
            parts: payload.parts,
            axisNames,
            columns: columnNames,
            maxRows,
          });
          if (workerGeometry) {
            return {
              shape: workerGeometry.shape as [number, number],
              data: workerGeometry.data,
              totalRowCount: rowCount,
              preloadTruncated: truncatePreload,
              // No feature key requested/available on this branch → no code column.
              hasFeatureCodeColumn: false,
            };
          }
        }
      } catch (error) {
        // An abort is intentional — don't swallow it into the main-thread fallback.
        if (error instanceof DOMException && error.name === 'AbortError') {
          throw error;
        }
        console.warn(
          `Worker points preload failed for ${elementPath}; falling back to main thread.`,
          error
        );
      }
    }

    // Guard the expensive main-thread fallback: if the load was superseded (e.g.
    // the memory cap changed), bail here rather than decode a whole capped table
    // on the main thread — the case that crashed the tab on large datasets.
    checkAbort(options.signal);

    const {
      table: arrowTable,
      totalRows,
      truncated,
    } = await this.loadParquetTableCapped(parquetPath, columnNames, maxRows);

    const axisColumnArrs = axisNames.map((name: string) => {
      const column = arrowTable.getChild(name);
      if (!column) {
        throw new Error(`Column "${name}" not found in the arrow table.`);
      }
      return column.toArray();
    });

    let featureCodes: ArrayLike<number> | undefined;
    let featureCatalog: PointsFeatureCatalog | undefined;
    if (featureKey) {
      const nameColumn = arrowTable.getChild(featureKey);
      if (nameColumn) {
        const codeColumn = featureCodeColumnName
          ? arrowTable.getChild(featureCodeColumnName)
          : null;
        featureCatalog = buildFeatureCatalogFromColumns(
          featureKey,
          nameColumn,
          codeColumn ?? null,
          null,
          arrowTable.numRows
        );
        const featureCodeByName = featureCodeColumnName
          ? undefined
          : featureCodeMapFromCatalog(featureCatalog);
        featureCodes = resolveRowFeatureCodesFromTable(
          arrowTable,
          featureKey,
          featureCodeColumnName,
          featureCodeByName
        );
      }
    }

    return {
      shape: [axisColumnArrs.length, arrowTable.numRows],
      data: axisColumnArrs,
      totalRowCount: totalRows,
      preloadTruncated: truncated,
      hasFeatureCodeColumn: featureCodeColumnName !== undefined,
      ...(featureCodes ? { featureCodes } : {}),
      ...(featureCatalog ? { featureCatalog } : {}),
    };
  }

  /**
   * Fetch enough parquet bytes (via async range reads) to cover `maxRows` for a
   * worker decode. Uses whole-part reads (decoded with `readParquet`) rather than
   * per-row-group reads: `readParquetRowGroup` mis-decodes dictionary-encoded
   * columns (e.g. `feature_name`) — the same reason `scanFeatureCatalogFromPayload`
   * falls back to parts — which would corrupt the catalog + codes. The fetch is
   * async I/O only; the CPU-heavy decode happens in the worker. Returns `null` if
   * no bytes are available.
   */
  private async fetchParquetPayloadCapped(
    parquetPath: string,
    maxRows: number
  ): Promise<{ parts: Uint8Array[] } | null> {
    const { parts } = await this.readParquetDatasetBytesCapped(parquetPath, maxRows);
    return parts.length > 0 ? { parts } : null;
  }

  async *loadPointsMatchingFeatureCodesByChunk(
    elementPath: string,
    options: {
      memoryCap: number;
      featureCodes: readonly number[];
      // no onProgress side-effect here, it's part of what we yield
      // we *do* want an AbortSignal, though.
      abort?: AbortSignal;
      /** Authoritative name→code map for dict-only elements (no `*_codes`
       * column), letting the scan resolve each row's `feature_name` to the same
       * code space the selection was made in. When absent for a dict-only
       * element the scan cannot match by name and returns nothing. */
      featureCodeByName?: ReadonlyMap<string, number>;
    }
  ) {
    ensurePointsWorker();
    checkAbort(options.abort);
    const parquetPath = getParquetPath(elementPath);
    const zattrs = await this.loadSpatialDataElementAttrs(elementPath);
    const { axes, spatialdata_attrs: spatialDataAttrs } = zattrs;
    const normAxes = normalizeAxes(axes);
    const axisNames = normAxes.map((axis: { name: string }) => axis.name);
    const axisCount = axisNames.length;
    const featureKey = spatialDataAttrs?.feature_key;
    if (typeof featureKey !== 'string' || featureKey.length === 0) {
      throw new Error(`Points element "${elementPath}" is missing feature_key metadata.`);
    }

    const totalRowCount = await this.resolveParquetRowCount(parquetPath);
    if (options.featureCodes.length === 0) {
      // Nothing selected: yield no chunks and return the summary. The collector
      // turns "no chunks matched" into an empty result via emptyFilteredPointsResult.
      return { totalRowCount, axisNames, scannedRows: 0, matchedRows: 0 };
    }

    if (!isPointsWorkerEnabled()) {
      throw new Error(
        'Feature-filtered points loading requires the points worker and parquet part bytes.'
      );
    }

    const datasetMetadata = await this.loadParquetDatasetMetadata(parquetPath);
    const schemaTable = datasetMetadata ? null : await this.loadParquetSchemaTable(parquetPath);
    const fields = datasetMetadata?.schema?.fields
      ? datasetMetadata.schema.fields.flatMap((field) =>
          typeof field.name === 'string' ? [field.name] : []
        )
      : arrowSchemaFieldNames(schemaTable);
    const featureCodeColumnName = selectFeatureCodeColumn(fields, featureKey);

    const columnNames = [...axisNames];
    if (featureCodeColumnName && !columnNames.includes(featureCodeColumnName)) {
      columnNames.push(featureCodeColumnName);
    } else if (!columnNames.includes(featureKey)) {
      columnNames.push(featureKey);
    }

    // Dict-only elements have no file-backed code column, so the worker resolves
    // each row's `feature_name` against this authoritative map (from the caller's
    // catalog) into the same code space the selection uses. A no-op for indexed
    // elements (they match on `featureCodeColumnName`).
    const featureCodeEntries =
      !featureCodeColumnName && options.featureCodeByName
        ? [...options.featureCodeByName].map(([name, code]) => ({ name, code }))
        : undefined;

    let matchedRows = 0;
    let scannedRows = 0;
    // Growing buffer of every matched chunk so far — `pointsScanChunkProgress`
    // concatenates it into each `progress.partialResult` for progressive display.
    const accumulatedChunks: ColumnarPointsChunk[] = [];

    // Row-group scanning only helps when a feature-code column lets footer stats
    // skip row groups (feature-ordered index). Dict-only elements have no stats to
    // skip on, so the row-group path would scan every group anyway — and its
    // projected decode of the *dictionary* feature_name column is unreliable for
    // multipart stores. Route dict-only scans through the parts path, which the
    // catalog build already uses successfully.
    const canUseRowGroups =
      featureCodeColumnName !== undefined && (await this.canLoadParquetRowGroups());
    const datasetRowGroups = datasetMetadata?.totalNumRowGroups ?? 0;

    if (canUseRowGroups && datasetRowGroups > 0) {
      // Feature-primary index: skip row groups whose feature-code range cannot
      // contain any selected code. For a feature-ordered file this leaves only
      // the few row groups a gene actually lives in, so we fetch/decode almost
      // nothing; unsorted files get `[]` (no stats) and fall back to a full scan.
      const selectedMin = Math.min(...options.featureCodes);
      const selectedMax = Math.max(...options.featureCodes);
      const rowGroupExtents =
        featureCodeColumnName && datasetMetadata
          ? rowGroupFeatureCodeExtents(
              datasetMetadata.parts,
              featureCodeColumnName,
              datasetRowGroups
            )
          : [];
      const canSkipRowGroups = rowGroupExtents.length === datasetRowGroups;

      for (let rowGroupIndex = 0; rowGroupIndex < datasetRowGroups; rowGroupIndex += 1) {
        // A superseded scan aborts here, between row groups — the at-most-one-chunk
        // bound on wasted decode. Throws AbortError, which the resolver's slot reads
        // as a non-event.
        checkAbort(options.abort);
        if (matchedRows >= options.memoryCap) {
          break;
        }
        if (
          canSkipRowGroups &&
          !extentMayContainSelectedCodes(rowGroupExtents[rowGroupIndex], selectedMin, selectedMax)
        ) {
          continue;
        }
        const chunk = await this.readParquetRowGroupBytesByGroupIndex(parquetPath, rowGroupIndex);
        if (!chunk) {
          continue;
        }
        // Cancellation is enforced between chunks (checkAbort above), not inside the
        // worker: each worker call decodes ONE row group — a single, uninterruptible
        // WASM decode — so an abort can at most skip the NEXT chunk, which is what the
        // loop-top check does. There is no queue of pending worker requests to drain
        // (chunks are awaited serially), so a worker-side cancel message would buy
        // nothing here; revisit only if one request ever spans many row groups.
        const partial = await scanParquetByFeatureCodesInWorker({
          rowGroups: [chunk],
          axisNames,
          featureKey,
          featureCodeColumnName,
          featureCodes: options.featureCodes,
          memoryCap: options.memoryCap - matchedRows,
          ...(featureCodeEntries ? { featureCodeEntries } : {}),
        });
        if (!partial) {
          throw new Error('Feature-filtered points loading requires the points worker.');
        }
        scannedRows += partial.scannedRows;
        if (partial.matchedRows > 0) {
          matchedRows += partial.matchedRows;
          const chunk = toColumnarPointsChunk(partial.data, axisCount);
          accumulatedChunks.push(chunk);
          yield pointsScanChunkProgress(accumulatedChunks, chunk, {
            scannedRows,
            matchedRows,
            totalRowCount,
            memoryCap: options.memoryCap,
            partIndex: rowGroupIndex,
            partCount: datasetRowGroups,
          });
        }
      }
    } else {
      let partPaths: string[];
      if (datasetMetadata?.parts.length && datasetMetadata.parts.length > 0) {
        partPaths = datasetMetadata.parts.map((part) => part.path);
      } else {
        partPaths = [parquetPath];
      }

      for (let partIndex = 0; partIndex < partPaths.length; partIndex += 1) {
        checkAbort(options.abort); // superseded → stop before the next part's decode
        const partPath = partPaths[partIndex];
        if (matchedRows >= options.memoryCap) {
          break;
        }
        const bytes = await this.loadParquetFileBytesAtPath(partPath);
        if (!bytes || bytes.length === 0) {
          continue;
        }
        const partial = await scanParquetByFeatureCodesInWorker({
          parts: [bytes],
          axisNames,
          featureKey,
          featureCodeColumnName,
          featureCodes: options.featureCodes,
          memoryCap: options.memoryCap - matchedRows,
          ...(featureCodeEntries ? { featureCodeEntries } : {}),
        });
        if (!partial) {
          throw new Error('Feature-filtered points loading requires the points worker.');
        }
        scannedRows += partial.scannedRows;
        if (partial.matchedRows > 0) {
          matchedRows += partial.matchedRows;
          const chunk = toColumnarPointsChunk(partial.data, axisCount);
          accumulatedChunks.push(chunk);
          yield pointsScanChunkProgress(accumulatedChunks, chunk, {
            scannedRows,
            matchedRows,
            totalRowCount,
            memoryCap: options.memoryCap,
            partIndex,
            partCount: partPaths.length,
          });
        }
      }
    }
    return { totalRowCount, axisNames, scannedRows, matchedRows };
  }
  async loadPointsMatchingFeatureCodes(
    elementPath: string,
    options: {
      memoryCap: number;
      featureCodes: readonly number[];
      onProgress?: (progress: PointsLoadProgress) => void;
      /** Authoritative name→code map for dict-only elements (no `*_codes`
       * column), letting the scan resolve each row's `feature_name` to the same
       * code space the selection was made in. When absent for a dict-only
       * element the scan cannot match by name and returns nothing. */
      featureCodeByName?: ReadonlyMap<string, number>;
      /** Aborts the scan between row-group chunks when it is superseded. */
      signal?: AbortSignal;
    }
  ): Promise<PointsLoadResult> {
    const chunkGenerator = this.loadPointsMatchingFeatureCodesByChunk(elementPath, {
      ...options,
      abort: options.signal,
    });
    // Each `progress.partialResult` is already the full accumulated buffer, so the
    // last one IS the whole matched batch — no need to re-accumulate/concat here.
    // Final totals come from the generator's return value (authoritative: it also
    // counts rows scanned after the last match, which the last partial can't see).
    let latest: PointsLoadResult | undefined;
    while (true) {
      checkAbort(options.signal);
      const next = await chunkGenerator.next();
      if (next.done) {
        const { totalRowCount, scannedRows, matchedRows, axisNames } = next.value;
        if (!latest) {
          return emptyFilteredPointsResult(axisNames, totalRowCount);
        }
        return {
          ...latest,
          totalRowCount,
          scannedRowCount: scannedRows,
          preloadTruncated: matchedRows >= options.memoryCap,
        };
      }
      options.onProgress?.(next.value.progress);
      latest = next.value.progress.partialResult;
    }
  }

  private async resolveExplicitFeatureCodeColumn(elementPath: string): Promise<{
    featureKey: string;
    featureCodeColumnName: string;
  } | null> {
    const parquetPath = getParquetPath(elementPath);
    const zattrs = await this.loadSpatialDataElementAttrs(elementPath);
    const featureKey = zattrs.spatialdata_attrs?.feature_key;
    if (typeof featureKey !== 'string' || featureKey.length === 0) {
      return null;
    }

    const datasetMetadata = await this.loadParquetDatasetMetadata(parquetPath);
    const schemaTable = datasetMetadata ? null : await this.loadParquetSchemaTable(parquetPath);
    const fields = datasetMetadata?.schema?.fields
      ? datasetMetadata.schema.fields.flatMap((field) =>
          typeof field.name === 'string' ? [field.name] : []
        )
      : arrowSchemaFieldNames(schemaTable);
    const featureCodeColumnName = selectFeatureCodeColumn(fields, featureKey);
    if (!featureCodeColumnName) {
      return null;
    }
    return { featureKey, featureCodeColumnName };
  }

  async loadFeatureCounts(elementPath: string): Promise<Map<number, number>> {
    const parquetPath = getParquetPath(elementPath);
    const resolvedFeatureColumn = await this.resolveExplicitFeatureCodeColumn(elementPath);
    if (!resolvedFeatureColumn) {
      return new Map();
    }
    const { featureKey, featureCodeColumnName } = resolvedFeatureColumn;
    const datasetMetadata = await this.loadParquetDatasetMetadata(parquetPath);
    const columnNames = [featureKey];
    if (!columnNames.includes(featureCodeColumnName)) {
      columnNames.push(featureCodeColumnName);
    }

    const canUseRowGroups = await this.canLoadParquetRowGroups();
    const datasetRowGroups = datasetMetadata?.totalNumRowGroups ?? 0;

    ensurePointsWorker();
    if (isPointsWorkerEnabled()) {
      try {
        const payload = await this.readParquetWorkerPayload(parquetPath, {
          maxRows: Number.POSITIVE_INFINITY,
          fullPartsForFallback: true,
          includeRowGroups: true,
        });
        const workerCounts = await scanParquetFeatureCountsInWorker(
          canUseRowGroups && datasetRowGroups > 0 && payload.rowGroups.length > 0
            ? {
                rowGroups: payload.rowGroups,
                featureKey,
                featureCodeColumnName,
              }
            : {
                parts: payload.parts,
                featureKey,
                featureCodeColumnName,
              }
        );
        if (workerCounts) {
          return workerCounts;
        }
      } catch (error) {
        console.warn(
          `Worker feature counts failed for ${elementPath}; falling back to main thread.`,
          error
        );
      }
    }

    if (canUseRowGroups && datasetRowGroups > 0) {
      const counts = new Map<number, number>();
      for (let rowGroupIndex = 0; rowGroupIndex < datasetRowGroups; rowGroupIndex += 1) {
        const table = await this.loadParquetRowGroupByGroupIndex(parquetPath, rowGroupIndex, {
          columns: columnNames,
        });
        if (table && table.numRows > 0) {
          const { scanTableFeatureCounts } = await import('../workers/pointsWorkerScan.js');
          scanTableFeatureCounts(table, featureKey, featureCodeColumnName, counts);
        }
      }
      return counts;
    }

    const { parts } = await this.readParquetDatasetBytesCapped(
      parquetPath,
      Number.POSITIVE_INFINITY
    );

    if (parts.length > 0) {
      const workerCounts = await scanParquetFeatureCountsInWorker({
        parts,
        featureKey,
        featureCodeColumnName,
      });
      if (workerCounts) {
        return workerCounts;
      }
    }

    const rowCodes = await this.loadPointsRowFeatureCodes(elementPath);
    if (!rowCodes) {
      return new Map();
    }
    const { countFeatureCodesHistogram } = await import('../pointsFeatures.js');
    return countFeatureCodesHistogram(rowCodes);
  }

  /**
   * The authoritative feature catalog, in two steps: the NAME/CODE list (cheap) and
   * then per-feature counts (a scan of every row group — the slow part).
   *
   * `onPartialCatalog` is called with the names-only catalog as soon as it is known,
   * before the counts scan starts. That is what lets the feature panel list features
   * immediately instead of showing "Loading features…" for the whole scan: the names
   * are what the list, swatches and selection need, and only the count column has to
   * wait.
   *
   * When the streaming scan applies it fires repeatedly *during* the name scan too,
   * each time with a longer list, so the panel fills in rather than appearing at
   * once. Codes are stable across those partials (see
   * `listPointsFeaturesByStreamingScan`), so earlier entries never move.
   */
  async listPointsFeaturesWithCounts(
    elementPath: string,
    options?: { onPartialCatalog?: (catalog: PointsFeatureCatalog) => void }
  ): Promise<PointsFeatureCatalog | null> {
    const catalog = await this.listPointsFeatures(elementPath, {
      onPartialCatalog: options?.onPartialCatalog,
    });
    if (!catalog) {
      return null;
    }
    options?.onPartialCatalog?.(catalog);
    try {
      const counts = await this.loadFeatureCounts(elementPath);
      return mergeFeatureCountsIntoCatalog(catalog, counts);
    } catch (error) {
      console.warn(`Failed to load feature counts for ${elementPath}:`, error);
      return catalog;
    }
  }

  /**
   * Load per-row feature codes aligned with {@link loadPoints} rows. Deferred from
   * geometry preload so large datasets do not block the first render. Parquet decode
   * and code extraction run on the points worker when enabled; falls back to the
   * main thread when the worker is unavailable.
   */
  async loadPointsRowFeatureCodes(
    elementPath: string,
    options: {
      memoryCap?: number;
      featureCatalog?: PointsFeatureCatalog | null;
      signal?: AbortSignal;
    } = {}
  ): Promise<ArrayLike<number> | undefined> {
    checkAbort(options.signal);
    const parquetPath = getParquetPath(elementPath);
    const zattrs = await this.loadSpatialDataElementAttrs(elementPath);
    const { spatialdata_attrs: spatialDataAttrs } = zattrs;
    const featureKey = spatialDataAttrs?.feature_key;
    if (typeof featureKey !== 'string' || featureKey.length === 0) {
      return undefined;
    }

    const datasetMetadata = await this.loadParquetDatasetMetadata(parquetPath);
    const schemaTable = datasetMetadata ? null : await this.loadParquetSchemaTable(parquetPath);
    const fields = datasetMetadata?.schema?.fields
      ? datasetMetadata.schema.fields.flatMap((field) =>
          typeof field.name === 'string' ? [field.name] : []
        )
      : arrowSchemaFieldNames(schemaTable);
    const featureCodeColumnName = selectFeatureCodeColumn(fields, featureKey);
    const featureCodeByName = featureCodeColumnName
      ? undefined
      : featureCodeMapFromCatalog(
          options.featureCatalog !== undefined
            ? options.featureCatalog
            : await this.listPointsFeatures(elementPath)
        );

    const rowCount = await this.resolveParquetRowCount(parquetPath);
    const memoryCap = resolvePointsMemoryCap(options.memoryCap);
    const maxRows = rowCount > memoryCap ? memoryCap : rowCount;

    const columnNames = [featureKey];
    if (featureCodeColumnName && !columnNames.includes(featureCodeColumnName)) {
      columnNames.push(featureCodeColumnName);
    }

    const featureCodeEntries = featureCodeByName
      ? [...featureCodeByName.entries()].map(([name, code]) => ({ name, code }))
      : undefined;

    ensurePointsWorker();
    if (isPointsWorkerEnabled()) {
      try {
        const payload = await this.readParquetWorkerPayload(parquetPath, { maxRows });
        const workerInput = {
          columns: columnNames,
          maxRows,
          featureKey,
          featureCodeColumnName,
          featureCodeEntries,
        };
        const workerCodes = await decodeParquetRowFeatureCodesInWorker(
          payload.rowGroups.length > 0
            ? { ...workerInput, rowGroups: payload.rowGroups }
            : { ...workerInput, parts: payload.parts }
        );
        if (workerCodes) {
          return workerCodes;
        }
      } catch (error) {
        console.warn(
          `Worker row feature codes failed for ${elementPath}; falling back to main thread.`,
          error
        );
      }
    }

    const { table: arrowTable } = await this.loadParquetTableCapped(
      parquetPath,
      columnNames,
      maxRows
    );
    return resolveRowFeatureCodesFromTable(
      arrowTable,
      featureKey,
      featureCodeColumnName,
      featureCodeByName
    );
  }

  async getPointsParquetRowCount(elementPath: string): Promise<number> {
    const parquetPath = getParquetPath(elementPath);
    return this.resolveParquetRowCount(parquetPath);
  }

  async listPointsFeatures(
    elementPath: string,
    options?: { onPartialCatalog?: (catalog: PointsFeatureCatalog) => void }
  ): Promise<PointsFeatureCatalog | null> {
    const zattrs = await this.loadSpatialDataElementAttrs(elementPath);
    const featureKey = zattrs.spatialdata_attrs?.feature_key;
    if (typeof featureKey !== 'string' || featureKey.length === 0) {
      return null;
    }

    const parquetPath = getParquetPath(elementPath);
    const datasetMetadata = await this.loadParquetDatasetMetadata(parquetPath);
    const schemaTable = datasetMetadata ? null : await this.loadParquetSchemaTable(parquetPath);
    const fields = datasetMetadata?.schema?.fields
      ? datasetMetadata.schema.fields.flatMap((field) =>
          typeof field.name === 'string' ? [field.name] : []
        )
      : arrowSchemaFieldNames(schemaTable);
    const featureCodeColumnName = selectFeatureCodeColumn(fields, featureKey);
    const hasMortonColumn = fields.includes(MORTON_CODE_2D_COLUMN);

    const rowCount = await this.resolveParquetRowCount(parquetPath);

    const columns = [featureKey];
    if (featureCodeColumnName) {
      columns.push(featureCodeColumnName);
    }
    if (hasMortonColumn) {
      columns.push(MORTON_CODE_2D_COLUMN);
    }

    if (rowCount > 0 && exceedsPointsPreloadLimit(rowCount)) {
      return this.listPointsFeaturesByFeatureColumnScan(
        parquetPath,
        featureKey,
        featureCodeColumnName,
        hasMortonColumn,
        options?.onPartialCatalog
      );
    }

    const arrowTable = await this.loadParquetTable(parquetPath, columns);
    const nameColumn = arrowTable.getChild(featureKey);
    const codeColumn = featureCodeColumnName ? arrowTable.getChild(featureCodeColumnName) : null;
    const mortonColumn = hasMortonColumn ? arrowTable.getChild(MORTON_CODE_2D_COLUMN) : null;

    if (!nameColumn) {
      return null;
    }

    return buildFeatureCatalogFromColumns(
      featureKey,
      nameColumn,
      codeColumn,
      mortonColumn,
      arrowTable.numRows
    );
  }

  /**
   * Build the feature catalog by streaming ONLY the feature column(s) over range
   * reads, publishing the catalog as it grows.
   *
   * This is the fast path for the oversized-dataset scan. The feature column is a
   * tiny fraction of a points parquet (~4KB of an 8.8MB Xenium-style file, the
   * rest being geometry and an unused dask index), so projecting it turns a
   * whole-file download into a handful of range requests.
   *
   * Codes stay compatible with every other catalog build: both assign codes in
   * first-seen row order, so a streamed prefix agrees with the whole-file scan on
   * every code it has assigned so far. That is what makes the partial catalogs
   * safe to render — a feature's code never changes as more rows arrive, so
   * selections and swatches made against a partial stay valid.
   *
   * Returns null (rather than throwing) whenever the fast path does not apply, so
   * the caller falls through to the byte-oriented scan.
   */
  private async listPointsFeaturesByStreamingScan(
    parquetPath: string,
    featureKey: string,
    featureCodeColumnName: string | undefined,
    hasMortonColumn: boolean,
    columnNames: string[],
    onPartialCatalog?: (catalog: PointsFeatureCatalog) => void
  ): Promise<PointsFeatureCatalog | null> {
    if (!(await this.canStreamParquetByUrl())) {
      return null;
    }
    // Use the discovered parts rather than guessing paths: these are known to
    // exist and are in row order, which the code assignment depends on.
    const datasetMetadata = await this.loadParquetDatasetMetadata(parquetPath);
    const partPaths = datasetMetadata?.parts.map((part) => part.path);
    if (!partPaths || partPaths.length === 0) {
      return null;
    }
    const partUrls: string[] = [];
    for (const partPath of partPaths) {
      const url = this.resolveStoreUrl(partPath);
      if (!url) {
        return null;
      }
      partUrls.push(url);
    }

    const { ParquetFile } = await SpatialDataTableSource.parquetModulePromise;
    if (!ParquetFile) {
      return null;
    }

    const { tableFromIPC } = await import('apache-arrow');
    const {
      accumulateFeatureCatalogFromTable,
      featureCatalogFromCodeMap,
      featureCatalogNeedsParquetFallback,
    } = await import('../pointsFeatures.js');
    const codeToName = new Map<number, string>();
    const nameToCode = new Map<string, number>();
    let publishedFeatureCount = 0;

    for (const url of partUrls) {
      const file = await ParquetFile.fromUrl(url);
      const stream = await file.stream({
        columns: columnNames,
        batchSize: FEATURE_STREAM_BATCH_ROWS,
      });
      const reader = stream.getReader();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) {
            break;
          }
          accumulateFeatureCatalogFromTable(
            codeToName,
            nameToCode,
            tableFromIPC(value.intoIPCStream()),
            featureKey,
            featureCodeColumnName,
            { skipMortonSentinels: hasMortonColumn }
          );
          // Only republish when the list actually grew; most batches add nothing
          // once the common features have been seen.
          if (onPartialCatalog && codeToName.size > publishedFeatureCount) {
            publishedFeatureCount = codeToName.size;
            onPartialCatalog(featureCatalogFromCodeMap(featureKey, codeToName));
          }
        }
      } finally {
        reader.releaseLock();
      }
    }

    if (featureCatalogNeedsParquetFallback(codeToName)) {
      return null;
    }
    return featureCatalogFromCodeMap(featureKey, codeToName);
  }

  /**
   * Build a feature catalog for oversized datasets by scanning only feature
   * columns (row-group range reads when available), not x/y geometry.
   */
  private async listPointsFeaturesByFeatureColumnScan(
    parquetPath: string,
    featureKey: string,
    featureCodeColumnName: string | undefined,
    hasMortonColumn: boolean,
    onPartialCatalog?: (catalog: PointsFeatureCatalog) => void
  ): Promise<PointsFeatureCatalog | null> {
    const columnNames = [featureKey];
    if (featureCodeColumnName) {
      columnNames.push(featureCodeColumnName);
    }
    if (hasMortonColumn) {
      columnNames.push(MORTON_CODE_2D_COLUMN);
    }

    // Fast path first: streaming reads only the feature column and can publish
    // the list while it scans. Falls through on any non-applicable store/runtime.
    try {
      const streamed = await this.listPointsFeaturesByStreamingScan(
        parquetPath,
        featureKey,
        featureCodeColumnName,
        hasMortonColumn,
        columnNames,
        onPartialCatalog
      );
      if (streamed) {
        return streamed;
      }
    } catch (error) {
      console.warn(
        `Streaming feature catalog scan failed for ${parquetPath}; falling back.`,
        error
      );
    }

    ensurePointsWorker();
    if (isPointsWorkerEnabled()) {
      try {
        const payload = await this.readParquetWorkerPayload(parquetPath, {
          maxRows: Number.POSITIVE_INFINITY,
          fullPartsForFallback: true,
          includeRowGroups: true,
        });
        const catalog = await scanParquetFeatureCatalogInWorker({
          rowGroups:
            featureCodeColumnName && payload.rowGroups.length > 0 ? payload.rowGroups : undefined,
          parts: payload.parts,
          columns: columnNames,
          featureKey,
          featureCodeColumnName,
          skipMortonSentinels: hasMortonColumn,
        });
        if (catalog) {
          return catalog;
        }
      } catch (error) {
        console.warn(
          `Worker feature catalog scan failed for ${parquetPath}; falling back to main thread.`,
          error
        );
      }
    }

    const {
      accumulateFeatureCatalogFromTable,
      featureCatalogFromCodeMap,
      featureCatalogNeedsParquetFallback,
    } = await import('../pointsFeatures.js');
    const codeToName = new Map<number, string>();
    const nameToCode = new Map<string, number>();
    const canUseRowGroups = await this.canLoadParquetRowGroups();
    const datasetMetadata = await this.loadParquetDatasetMetadata(parquetPath);

    if (
      canUseRowGroups &&
      datasetMetadata &&
      datasetMetadata.totalNumRowGroups > 0 &&
      featureCodeColumnName
    ) {
      for (
        let rowGroupIndex = 0;
        rowGroupIndex < datasetMetadata.totalNumRowGroups;
        rowGroupIndex += 1
      ) {
        const table = await this.loadParquetRowGroupByGroupIndex(parquetPath, rowGroupIndex, {
          columns: columnNames,
        });
        if (!table || table.numRows === 0) {
          continue;
        }
        accumulateFeatureCatalogFromTable(
          codeToName,
          nameToCode,
          table,
          featureKey,
          featureCodeColumnName,
          { skipMortonSentinels: hasMortonColumn }
        );
      }
    }

    if (featureCatalogNeedsParquetFallback(codeToName)) {
      codeToName.clear();
      nameToCode.clear();
      const arrowTable = await this.loadParquetTable(parquetPath, columnNames);
      accumulateFeatureCatalogFromTable(
        codeToName,
        nameToCode,
        arrowTable,
        featureKey,
        featureCodeColumnName,
        { skipMortonSentinels: hasMortonColumn }
      );
    }

    if (codeToName.size === 0) {
      return null;
    }
    return featureCatalogFromCodeMap(featureKey, codeToName);
  }

  async getPointsTilingMetadata(elementPath: string): Promise<PointsTilingMetadata | null> {
    if (this.pointTilingMetadataCache.has(elementPath)) {
      return this.pointTilingMetadataCache.get(elementPath) ?? null;
    }
    const promise = this.loadPointsTilingMetadataUncached(elementPath).catch((error) => {
      this.pointTilingMetadataCache.delete(elementPath);
      throw error;
    });
    this.pointTilingMetadataCache.set(elementPath, promise);
    return promise;
  }

  private async loadPointsTilingMetadataUncached(
    elementPath: string
  ): Promise<PointsTilingMetadata | null> {
    const parquetPath = getParquetPath(elementPath);
    const zattrs = await this.loadSpatialDataElementAttrs(elementPath);
    const { axes, spatialdata_attrs: spatialDataAttrs } = zattrs;
    const normAxes = normalizeAxes(axes);
    const axisNames = normAxes.map((axis: { name: string }) => axis.name);
    const { feature_key: featureKey } = spatialDataAttrs;

    const datasetMetadata = await this.loadParquetDatasetMetadata(parquetPath);
    const schemaTable = datasetMetadata ? null : await this.loadParquetSchemaTable(parquetPath);
    const fields = datasetMetadata?.schema?.fields
      ? datasetMetadata.schema.fields.flatMap((field) =>
          typeof field.name === 'string' ? [field.name] : []
        )
      : arrowSchemaFieldNames(schemaTable);

    const featureCodeColumnName = selectFeatureCodeColumn(fields, featureKey);
    if (
      !fields.includes('x') ||
      !fields.includes('y') ||
      !fields.includes(MORTON_CODE_2D_COLUMN) ||
      !featureCodeColumnName
    ) {
      return null;
    }

    const canLoadRowGroups = await this.canLoadParquetRowGroups();
    const firstRowGroupRowCount = datasetMetadata?.rowGroupRows?.[0] ?? 0;
    const hasValidSentinelRowGroup = firstRowGroupRowCount >= 2 && firstRowGroupRowCount <= 4;
    const firstRowGroup =
      datasetMetadata && canLoadRowGroups && hasValidSentinelRowGroup
        ? await this.loadParquetRowGroupByGroupIndex(parquetPath, 0, {
            columns: ['x', 'y', MORTON_CODE_2D_COLUMN],
            limit: 4,
          })
        : null;
    const bounds = firstRowGroup
      ? (extractSentinelBoundingBox(firstRowGroup) ?? undefined)
      : undefined;
    const rowGroupSizes = datasetMetadata?.rowGroupRows ?? [];

    const metadata: PointsTilingMetadata = {
      kind: 'morton-points',
      parquetPath,
      axisNames,
      featureKey,
      featureCodeColumnName,
      mortonCodeColumnName: MORTON_CODE_2D_COLUMN,
      totalRows: datasetMetadata?.totalNumRows ?? 0,
      totalRowGroups: datasetMetadata?.totalNumRowGroups ?? 0,
      maxRowsPerGroup: rowGroupSizes.length ? Math.max(...rowGroupSizes) : 0,
      rowGroupRowCounts: datasetMetadata?.rowGroupRows,
      supportsRowGroupRangeReads: Boolean(datasetMetadata && canLoadRowGroups && bounds),
      bounds,
    };

    return metadata;
  }

  async loadPointsInBounds(
    elementPath: string,
    options: PointsInBoundsOptions
  ): Promise<PointsInBoundsResponse> {
    checkAbort(options.signal);
    const metadata = await this.getPointsTilingMetadata(elementPath);
    if (metadata?.supportsRowGroupRangeReads && metadata.bounds) {
      const rowGroupResult = await this.loadMortonPointsInBounds(elementPath, metadata, options);
      if (rowGroupResult) {
        return rowGroupResult;
      }
    }
    checkAbort(options.signal);
    const full = await this.loadPointsWithOptionalFeatureCodes(elementPath, metadata, options);
    checkAbort(options.signal);
    return filterPointsToBounds(
      full.data,
      options.bounds,
      undefined,
      options.featureCodes,
      full.featureCodes
    );
  }

  private async loadPointsWithOptionalFeatureCodes(
    elementPath: string,
    metadata: PointsTilingMetadata | null,
    options: PointsInBoundsOptions
  ) {
    const parquetPath = getParquetPath(elementPath);
    const zattrs = await this.loadSpatialDataElementAttrs(elementPath);
    const { axes, spatialdata_attrs: spatialDataAttrs } = zattrs;
    const normAxes = normalizeAxes(axes);
    const axisNames = normAxes.map((axis: { name: string }) => axis.name);
    const { feature_key: featureKey } = spatialDataAttrs;
    let featureCodeColumnName = metadata?.featureCodeColumnName;
    const needsFeatureFilter = options.featureCodes !== undefined;
    if (!featureCodeColumnName && needsFeatureFilter) {
      const datasetMetadata = await this.loadParquetDatasetMetadata(parquetPath);
      const schemaTable = datasetMetadata ? null : await this.loadParquetSchemaTable(parquetPath);
      const fields = datasetMetadata?.schema?.fields
        ? datasetMetadata.schema.fields.flatMap((field) =>
            typeof field.name === 'string' ? [field.name] : []
          )
        : arrowSchemaFieldNames(schemaTable);
      featureCodeColumnName = selectFeatureCodeColumn(fields, featureKey);
    }
    const resolvedFeatureCodeColumn =
      typeof featureCodeColumnName === 'string' ? featureCodeColumnName : undefined;
    const featureCodeByName = resolvedFeatureCodeColumn
      ? undefined
      : featureCodeMapFromCatalog(await this.listPointsFeatures(elementPath));
    const columnNames = [...axisNames];
    if (needsFeatureFilter) {
      if (resolvedFeatureCodeColumn) {
        columnNames.push(resolvedFeatureCodeColumn);
      } else if (typeof featureKey === 'string' && !columnNames.includes(featureKey)) {
        columnNames.push(featureKey);
      }
    }
    const featureCodeEntries = featureCodeByName
      ? [...featureCodeByName.entries()].map(([name, code]) => ({ name, code }))
      : undefined;

    ensurePointsWorker();
    if (isPointsWorkerEnabled()) {
      try {
        const payload = await this.readParquetWorkerPayload(parquetPath, {
          maxRows: Number.POSITIVE_INFINITY,
          fullPartsForFallback: true,
          includeRowGroups: true,
        });
        const workerResult = await decodeParquetGeometryCappedInWorker(
          payload.rowGroups.length > 0
            ? {
                rowGroups: payload.rowGroups,
                axisNames,
                columns: columnNames,
                maxRows: Number.POSITIVE_INFINITY,
                featureKey: needsFeatureFilter ? featureKey : undefined,
                featureCodeColumnName: resolvedFeatureCodeColumn,
                featureCodeEntries,
              }
            : {
                parts: payload.parts,
                axisNames,
                columns: columnNames,
                maxRows: Number.POSITIVE_INFINITY,
                featureKey: needsFeatureFilter ? featureKey : undefined,
                featureCodeColumnName: resolvedFeatureCodeColumn,
                featureCodeEntries,
              }
        );
        if (workerResult) {
          return {
            data: {
              shape: workerResult.shape as [number, number],
              data: workerResult.data,
            },
            featureCodes: workerResult.featureCodes,
          };
        }
      } catch (error) {
        console.warn(
          `Worker bounds geometry load failed for ${elementPath}; falling back to main thread.`,
          error
        );
      }
    }

    const arrowTable = await this.loadParquetTable(parquetPath, columnNames);
    const axisColumnArrs = axisNames.map((name: string) => {
      const column = arrowTable.getChild(name);
      if (!column) {
        throw new Error(`Column "${name}" not found in the arrow table.`);
      }
      return column.toArray();
    });
    const featureCodes = needsFeatureFilter
      ? resolveRowFeatureCodesFromTable(
          arrowTable,
          featureKey,
          resolvedFeatureCodeColumn,
          featureCodeByName
        )
      : undefined;
    return {
      data: {
        shape: [axisColumnArrs.length, arrowTable.numRows],
        data: axisColumnArrs,
      },
      featureCodes,
    };
  }

  private async bisectRowGroupsRight(
    parquetPath: string,
    totalRowGroups: number,
    targetValue: number
  ) {
    let lo = 0;
    let hi = totalRowGroups;
    while (lo < hi) {
      const mid = Math.floor((lo + hi) / 2);
      const extent = await this.loadParquetRowGroupColumnExtent(
        parquetPath,
        MORTON_CODE_2D_COLUMN,
        mid
      );
      const max = extent?.max;
      if (max === null || max === undefined || targetValue <= max) {
        hi = mid;
      } else {
        lo = mid + 1;
      }
    }
    return lo;
  }

  private async loadMortonPointsInBounds(
    elementPath: string,
    metadata: PointsTilingMetadata,
    options: PointsInBoundsOptions
  ): Promise<PointsInBoundsResponse | null> {
    if (!metadata.bounds || metadata.totalRowGroups <= 0) {
      return null;
    }
    checkAbort(options.signal);
    const allowedFeatureCodes = featureCodeAllowSet(options.featureCodes);
    const intervals = mortonIntervalsForBounds(metadata.bounds, options.bounds);
    const rowGroupSet = new Set<number>();
    for (const [start, end] of intervals) {
      const first = await this.bisectRowGroupsRight(
        metadata.parquetPath,
        metadata.totalRowGroups,
        start
      );
      const last = await this.bisectRowGroupsRight(
        metadata.parquetPath,
        metadata.totalRowGroups,
        end
      );
      for (let rowGroup = first; rowGroup <= last; rowGroup++) {
        if (rowGroup >= 0 && rowGroup < metadata.totalRowGroups) {
          rowGroupSet.add(rowGroup);
        }
      }
    }
    const rowGroups = [...rowGroupSet].sort((a, b) => a - b);
    const totalRowsUpperBound = rowGroups.reduce(
      (sum, rowGroup) => sum + rowGroupCountForIndex(metadata, rowGroup),
      0
    );
    if (totalRowsUpperBound === 0) {
      return null;
    }

    const xs: number[] = [];
    const ys: number[] = [];
    const zs: number[] = [];
    const hasZ = metadata.axisNames.includes('z');
    const filterByFeature = allowedFeatureCodes !== null;
    const featureCodeColumnName =
      filterByFeature && metadata.featureCodeColumnName
        ? metadata.featureCodeColumnName
        : undefined;

    ensurePointsWorker();
    if (isPointsWorkerEnabled()) {
      const rowGroupChunks = [];
      for (const rowGroup of rowGroups) {
        checkAbort(options.signal);
        const chunk = await this.readParquetRowGroupBytesByGroupIndex(
          metadata.parquetPath,
          rowGroup
        );
        if (chunk) {
          rowGroupChunks.push(chunk);
        }
      }
      if (rowGroupChunks.length > 0) {
        try {
          const workerResult = await scanMortonRowGroupsInBoundsInWorker({
            rowGroups: rowGroupChunks,
            bounds: options.bounds,
            axisNames: metadata.axisNames,
            mortonCodeColumnName: metadata.mortonCodeColumnName,
            featureCodeColumnName,
            featureCodes: options.featureCodes,
          });
          if (workerResult) {
            return {
              data: workerResult.data,
              shape: workerResult.shape as [number, number],
              bounds: options.bounds,
              loadMode: 'row-groups',
              tiling: metadata,
            };
          }
        } catch (error) {
          console.warn(
            `Worker morton tile load failed for ${elementPath}; falling back to main thread.`,
            error
          );
        }
      }
    }

    const rowGroupColumns = [
      'x',
      'y',
      ...(hasZ ? ['z'] : []),
      metadata.mortonCodeColumnName,
      ...(featureCodeColumnName ? [featureCodeColumnName] : []),
    ];
    for (const rowGroup of rowGroups) {
      checkAbort(options.signal);
      const table = await this.loadParquetRowGroupByGroupIndex(metadata.parquetPath, rowGroup, {
        columns: rowGroupColumns,
      });
      if (!table) {
        continue;
      }
      const { scanMortonTableInBounds } = await import('../workers/pointsWorkerScan.js');
      scanMortonTableInBounds({
        table,
        rowGroupIndex: rowGroup,
        bounds: options.bounds,
        axisNames: metadata.axisNames,
        mortonCodeColumnName: metadata.mortonCodeColumnName,
        featureCodeColumnName,
        featureCodes: options.featureCodes,
        xs,
        ys,
        zs,
      });
    }

    if (xs.length === 0) {
      return null;
    }

    return {
      data: hasZ
        ? [new Float32Array(xs), new Float32Array(ys), new Float32Array(zs)]
        : [new Float32Array(xs), new Float32Array(ys)],
      shape: [hasZ ? 3 : 2, xs.length],
      bounds: options.bounds,
      loadMode: 'row-groups',
      tiling: metadata,
    };
  }
}
