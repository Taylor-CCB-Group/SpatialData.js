import { basename } from '../Vutils';
import {
  buildFeatureCatalogFromColumns,
  featureCodeMapFromCatalog,
  mergeFeatureCountsIntoCatalog,
  resolveRowFeatureCodesFromTable,
} from '../pointsFeatures.js';
import {
  decodeParquetGeometryCappedInWorker,
  decodeParquetRowFeatureCodesInWorker,
  ensurePointsWorker,
  isPointsWorkerEnabled,
  scanMortonRowGroupsInBoundsInWorker,
  scanParquetByFeatureCodesInWorker,
  scanParquetFeatureCatalogInWorker,
  scanParquetFeatureCountsInWorker,
} from '../workers/pointsWorkerClient.js';
import { exceedsPointsPreloadLimit, resolvePointsMemoryCap } from '../pointsLimits.js';
import type {
  PointsLoadOptions,
  PointsLoadProgress,
  PointsLoadResult,
} from '../pointsLoadOptions.js';

interface ColumnarPointsChunk {
  shape: number[];
  data: ArrayLike<number>[];
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
  data: { shape?: number[]; data: ArrayLike<number>[] },
  axisCount: number
): ColumnarPointsChunk {
  const rowCount = data.shape?.[1] ?? data.data[0]?.length ?? 0;
  return {
    shape: data.shape ?? [axisCount, rowCount],
    data: data.data,
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
  return { shape: [axisCount, totalRows], data };
}
import {
  MORTON_CODE_2D_COLUMN,
  type PointsInBoundsOptions,
  type PointsInBoundsResponse,
  type PointsFeatureCatalog,
  type PointsTilingMetadata,
  extractSentinelBoundingBox,
  featureCodeAllowSet,
  filterPointsToBounds,
  mortonIntervalsForBounds,
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
  async loadPoints(
    elementPath: string,
    options: PointsLoadOptions = {}
  ): Promise<PointsLoadResult> {
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

    ensurePointsWorker();
    if (isPointsWorkerEnabled()) {
      try {
        const payload = await this.readParquetWorkerPayload(parquetPath, { maxRows });
        const workerGeometry = await decodeParquetGeometryCappedInWorker(
          {
            parts: payload.parts,
            axisNames,
            columns: columnNames,
            maxRows,
          }
        );
        if (workerGeometry) {
          return {
            shape: workerGeometry.shape as [number, number],
            data: workerGeometry.data,
            totalRowCount: rowCount,
            preloadTruncated: truncatePreload,
          };
        }
      } catch (error) {
        console.warn(
          `Worker geometry preload failed for ${elementPath}; falling back to main thread.`,
          error
        );
      }
    }

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

    return {
      shape: [axisColumnArrs.length, arrowTable.numRows],
      data: axisColumnArrs,
      totalRowCount: totalRows,
      preloadTruncated: truncated,
    };
  }

  private async loadPointsMatchingFeatureCodes(
    elementPath: string,
    options: {
      memoryCap: number;
      featureCodes: readonly number[];
      onProgress?: (progress: PointsLoadProgress) => void;
    }
  ): Promise<PointsLoadResult> {
    ensurePointsWorker();
    const parquetPath = getParquetPath(elementPath);
    const zattrs = await this.loadSpatialDataElementAttrs(elementPath);
    const { axes, spatialdata_attrs: spatialDataAttrs } = zattrs;
    const normAxes = normalizeAxes(axes);
    const axisNames = normAxes.map((axis: { name: string }) => axis.name);
    const featureKey = spatialDataAttrs?.feature_key;
    if (typeof featureKey !== 'string' || featureKey.length === 0) {
      throw new Error(`Points element "${elementPath}" is missing feature_key metadata.`);
    }

    const totalRowCount = await this.resolveParquetRowCount(parquetPath);
    if (options.featureCodes.length === 0) {
      return emptyFilteredPointsResult(axisNames, totalRowCount);
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

    const matchedChunks: ColumnarPointsChunk[] = [];
    let matchedRows = 0;
    let scannedRows = 0;

    const canUseRowGroups = await this.canLoadParquetRowGroups();
    const datasetRowGroups = datasetMetadata?.totalNumRowGroups ?? 0;

    if (canUseRowGroups && datasetRowGroups > 0) {
      for (let rowGroupIndex = 0; rowGroupIndex < datasetRowGroups; rowGroupIndex += 1) {
        if (matchedRows >= options.memoryCap) {
          break;
        }
        const chunk = await this.readParquetRowGroupBytesByGroupIndex(parquetPath, rowGroupIndex);
        if (!chunk) {
          continue;
        }
        const partial = await scanParquetByFeatureCodesInWorker({
          rowGroups: [chunk],
          axisNames,
          featureKey,
          featureCodeColumnName,
          featureCodes: options.featureCodes,
          memoryCap: options.memoryCap - matchedRows,
        });
        if (!partial) {
          throw new Error('Feature-filtered points loading requires the points worker.');
        }
        scannedRows += partial.scannedRows;
        if (partial.matchedRows > 0) {
          matchedChunks.push(toColumnarPointsChunk(partial.data, axisNames.length));
          matchedRows += partial.matchedRows;
        }
        options.onProgress?.({
          scannedRows,
          matchedRows,
          partIndex: rowGroupIndex,
          partCount: datasetRowGroups,
        });
      }
    } else {
      let partPaths: string[];
      if (datasetMetadata?.parts.length && datasetMetadata.parts.length > 0) {
        partPaths = datasetMetadata.parts.map((part) => part.path);
      } else {
        partPaths = [parquetPath];
      }

      for (let partIndex = 0; partIndex < partPaths.length; partIndex += 1) {
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
        });
        if (!partial) {
          throw new Error('Feature-filtered points loading requires the points worker.');
        }
        scannedRows += partial.scannedRows;
        if (partial.matchedRows > 0) {
          matchedChunks.push(toColumnarPointsChunk(partial.data, axisNames.length));
          matchedRows += partial.matchedRows;
        }
        options.onProgress?.({
          scannedRows,
          matchedRows,
          partIndex,
          partCount: partPaths.length,
        });
      }
    }

    const data = concatColumnarPointChunks(matchedChunks);
    return {
      shape: data.shape,
      data: data.data,
      totalRowCount,
      scannedRowCount: scannedRows,
      filterActive: true,
      preloadTruncated: matchedRows >= options.memoryCap,
    };
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

  async listPointsFeaturesWithCounts(elementPath: string): Promise<PointsFeatureCatalog | null> {
    const catalog = await this.listPointsFeatures(elementPath);
    if (!catalog) {
      return null;
    }
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
    } = {}
  ): Promise<ArrayLike<number> | undefined> {
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

  async listPointsFeatures(elementPath: string): Promise<PointsFeatureCatalog | null> {
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
        hasMortonColumn
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
   * Build a feature catalog for oversized datasets by scanning only feature
   * columns (row-group range reads when available), not x/y geometry.
   */
  private async listPointsFeaturesByFeatureColumnScan(
    parquetPath: string,
    featureKey: string,
    featureCodeColumnName: string | undefined,
    hasMortonColumn: boolean
  ): Promise<PointsFeatureCatalog | null> {
    const columnNames = [featureKey];
    if (featureCodeColumnName) {
      columnNames.push(featureCodeColumnName);
    }
    if (hasMortonColumn) {
      columnNames.push(MORTON_CODE_2D_COLUMN);
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
            featureCodeColumnName && payload.rowGroups.length > 0
              ? payload.rowGroups
              : undefined,
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

    const { accumulateFeatureCatalogFromTable, featureCatalogFromCodeMap, featureCatalogNeedsParquetFallback } =
      await import('../pointsFeatures.js');
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
    const promise = this.loadPointsTilingMetadataUncached(elementPath).catch(error => {
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
