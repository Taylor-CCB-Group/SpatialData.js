import { basename } from '../Vutils';
import {
  buildFeatureCatalogFromColumns,
  buildFeatureCatalogFromDictionaryOnly,
  isDictionaryFeatureColumn,
  resolveRowFeatureCodesFromTable,
} from '../pointsFeatures.js';
import {
  decodeParquetPartsInWorker,
  isPointsWorkerEnabled,
} from '../workers/pointsWorkerClient.js';
import {
  exceedsPointsPreloadLimit,
  POINTS_PRELOAD_MAX_ROWS,
} from '../pointsLimits.js';
import {
  MORTON_CODE_2D_COLUMN,
  type PointsInBoundsOptions,
  type PointsInBoundsResult,
  type PointsFeatureCatalog,
  type PointsTilingMetadata,
  extractSentinelBoundingBox,
  featureCodeAllowSet,
  filterPointsToBounds,
  isMortonSentinelValue,
  mortonIntervalsForBounds,
  rowMatchesFeatureCode,
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
  async loadPoints(elementPath: string) {
    const parquetPath = getParquetPath(elementPath);

    const zattrs = await this.loadSpatialDataElementAttrs(elementPath);
    const { axes } = zattrs;
    const normAxes = normalizeAxes(axes);
    const axisNames = normAxes.map((axis: { name: string }) => axis.name);

    const rowCount = await this.resolveParquetRowCount(parquetPath);
    const truncatePreload = rowCount > POINTS_PRELOAD_MAX_ROWS;
    const maxRows = truncatePreload ? POINTS_PRELOAD_MAX_ROWS : rowCount;

    const columnNames = [...axisNames];

    if (isPointsWorkerEnabled()) {
      const { parts, totalRows, truncated } = await this.readParquetDatasetBytesCapped(
        parquetPath,
        maxRows
      );
      if (parts.length > 0) {
        const arrowTable = await decodeParquetPartsInWorker(
          parts,
          columnNames,
          truncated ? maxRows : undefined
        );
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
    }

    const { table: arrowTable, totalRows, truncated } = await this.loadParquetTableCapped(
      parquetPath,
      columnNames,
      maxRows
    );

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

  /**
   * Load per-row feature codes aligned with {@link loadPoints} rows. Deferred from
   * geometry preload so large datasets do not block the first render.
   */
  async loadPointsRowFeatureCodes(elementPath: string): Promise<ArrayLike<number> | undefined> {
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

    const rowCount = await this.resolveParquetRowCount(parquetPath);
    const maxRows =
      rowCount > POINTS_PRELOAD_MAX_ROWS ? POINTS_PRELOAD_MAX_ROWS : rowCount;

    const columnNames = [featureKey];
    if (featureCodeColumnName && !columnNames.includes(featureCodeColumnName)) {
      columnNames.push(featureCodeColumnName);
    }

    if (isPointsWorkerEnabled()) {
      const { parts, truncated } = await this.readParquetDatasetBytesCapped(
        parquetPath,
        maxRows
      );
      if (parts.length > 0) {
        const arrowTable = await decodeParquetPartsInWorker(
          parts,
          columnNames,
          truncated ? maxRows : undefined
        );
        return resolveRowFeatureCodesFromTable(
          arrowTable,
          featureKey,
          featureCodeColumnName
        );
      }
    }

    const { table: arrowTable } = await this.loadParquetTableCapped(
      parquetPath,
      columnNames,
      maxRows
    );
    return resolveRowFeatureCodesFromTable(arrowTable, featureKey, featureCodeColumnName);
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
      const probeTable = (
        await this.loadParquetTableCapped(parquetPath, columns, 1)
      ).table;
      const nameColumn = probeTable.getChild(featureKey);
      if (!nameColumn) {
        return null;
      }
      if (isDictionaryFeatureColumn(nameColumn)) {
        const codeColumn = featureCodeColumnName
          ? probeTable.getChild(featureCodeColumnName)
          : null;
        return buildFeatureCatalogFromDictionaryOnly(featureKey, nameColumn, codeColumn);
      }
      console.warn(
        `[SpatialDataPointsSource] Skipping feature catalog for ${elementPath}: ${rowCount.toLocaleString()} rows exceeds preload limit and feature column is not dictionary-encoded.`
      );
      return null;
    }

    const arrowTable = await this.loadParquetTable(parquetPath, columns);
    const nameColumn = arrowTable.getChild(featureKey);
    const codeColumn = featureCodeColumnName
      ? arrowTable.getChild(featureCodeColumnName)
      : null;
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

  async getPointsTilingMetadata(elementPath: string): Promise<PointsTilingMetadata | null> {
    if (this.pointTilingMetadataCache.has(elementPath)) {
      return this.pointTilingMetadataCache.get(elementPath) ?? null;
    }
    const promise = this.loadPointsTilingMetadataUncached(elementPath);
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
    const firstRowGroup =
      datasetMetadata && canLoadRowGroups
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
  ): Promise<PointsInBoundsResult> {
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
    const columnNames = [...axisNames];
    if (needsFeatureFilter) {
      if (resolvedFeatureCodeColumn) {
        columnNames.push(resolvedFeatureCodeColumn);
      } else if (typeof featureKey === 'string' && !columnNames.includes(featureKey)) {
        columnNames.push(featureKey);
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
      ? resolveRowFeatureCodesFromTable(arrowTable, featureKey, resolvedFeatureCodeColumn)
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
  ): Promise<PointsInBoundsResult | null> {
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
      return {
        data: [new Float32Array(0), new Float32Array(0)],
        shape: [2, 0],
        bounds: options.bounds,
        loadMode: 'row-groups',
        tiling: metadata,
      };
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
      const xColumn = table?.getChild('x');
      const yColumn = table?.getChild('y');
      const zColumn = hasZ ? table?.getChild('z') : undefined;
      const mortonColumn = table?.getChild(metadata.mortonCodeColumnName);
      const featureCodeColumn = featureCodeColumnName
        ? table?.getChild(featureCodeColumnName)
        : undefined;
      if (!table || !xColumn || !yColumn) {
        continue;
      }
      for (let i = 0; i < table.numRows; i++) {
        if (rowGroup === 0 && i < 4 && isMortonSentinelValue(mortonColumn?.get(i))) {
          continue;
        }
        if (
          filterByFeature &&
          featureCodeColumn &&
          !rowMatchesFeatureCode(featureCodeColumn.get(i), allowedFeatureCodes)
        ) {
          continue;
        }
        const x = xColumn.get(i);
        const y = yColumn.get(i);
        if (typeof x !== 'number' || typeof y !== 'number') {
          continue;
        }
        if (
          x < options.bounds.minX ||
          x > options.bounds.maxX ||
          y < options.bounds.minY ||
          y > options.bounds.maxY
        ) {
          continue;
        }
        xs.push(x);
        ys.push(y);
        if (hasZ) {
          const z = zColumn?.get(i);
          zs.push(typeof z === 'number' ? z : 0);
        }
      }
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
