// this is a direct copy of the Vitessce implementation, with changes mostly to make it more normal TypeScript.

import { type Table as ArrowTable, tableFromIPC } from 'apache-arrow';
import type { DataSourceParams } from '../Vutils';
import type { TableColumnData } from '../types';
import AnnDataSource from './VAnnDataSource';

interface ParquetWasmTableLike {
  intoIPCStream(): Uint8Array;
}

interface ParquetWasmFileMetadata {
  numRows(): number;
}

interface ParquetWasmRowGroupMetadata {
  numRows(): number;
  fileOffset(): number | bigint;
  compressedSize(): number | bigint;
}

interface ParquetWasmMetadata {
  fileMetadata(): ParquetWasmFileMetadata;
  numRowGroups(): number;
  rowGroup(index: number): ParquetWasmRowGroupMetadata;
}

interface ParquetModule {
  readParquet: (bytes: Uint8Array, options?: { columns?: string[] }) => ParquetWasmTableLike;
  readSchema: (bytes: Uint8Array) => ParquetWasmTableLike;
  readMetadata?: (bytes: Uint8Array) => ParquetWasmMetadata;
  readParquetRowGroup?: (
    schemaBytes: Uint8Array,
    rowGroupBytes: Uint8Array,
    rowGroupIndex: number
  ) => ParquetWasmTableLike;
}

export interface ParquetPartMetadata {
  path: string;
  schema: ArrowTable['schema'];
  schemaBytes: Uint8Array;
  metadata: ParquetWasmMetadata;
}

export interface ParquetDatasetMetadata {
  totalNumRows: number;
  totalNumRowGroups: number;
  numRowsByPart: number[];
  numRowGroupsByPart: number[];
  numRowsPerGroupByPart: number[];
  rowGroupRows: number[];
  schema: ArrowTable['schema'] | null;
  parts: ParquetPartMetadata[];
}

// Note: This file also serves as the parent for
// SpatialDataPointsSource and SpatialDataShapesSource,
// because when a table annotates points and shapes, it can be helpful to
// have all of the required functionality to load the
// table data and the parquet data.

function normalizeParquetModule(module: unknown): ParquetModule {
  if (typeof module !== 'object' || module === null) {
    throw new Error('parquet-wasm module did not load as an object');
  }
  // External WASM builds have drifted API surfaces and incomplete declarations;
  // keep the boundary narrow and capability-check every optional method.
  const candidate = module as Record<string, unknown>;
  const { readParquet, readSchema, readMetadata, readParquetRowGroup } = candidate;
  if (typeof readParquet !== 'function' || typeof readSchema !== 'function') {
    throw new Error('parquet-wasm module is missing required readParquet/readSchema APIs');
  }
  return {
    readParquet: readParquet as ParquetModule['readParquet'],
    readSchema: readSchema as ParquetModule['readSchema'],
    readMetadata:
      typeof readMetadata === 'function'
        ? (readMetadata as ParquetModule['readMetadata'])
        : undefined,
    readParquetRowGroup:
      typeof readParquetRowGroup === 'function'
        ? (readParquetRowGroup as ParquetModule['readParquetRowGroup'])
        : undefined,
  };
}

async function initializeParquetModule(module: unknown) {
  if (typeof module !== 'object' || module === null) {
    return;
  }
  const maybeInit = (module as Record<string, unknown>).default;
  if (typeof maybeInit === 'function') {
    await maybeInit();
  }
}

async function getParquetModule() {
  // Dynamic import for code-splitting. parquet-wasm is a WebAssembly module
  // that needs to be initialized before use in browser environments.
  // In Node.js, the module loads WASM synchronously so no init is needed.
  //
  // TODO: Replace with a more civilised parquet module that's built in a way we can actually consume.
  // - probably ultimately may be using geoarrow-wasm / investigate deck.gl arrow layer
  //   think about how that fits our 'core' (no deck deps) vs 'vis' structure etc.

  // Try local import first (works in Node.js, tests, and production builds)
  try {
    const module = await import('parquet-wasm');
    await initializeParquetModule(module);
    return normalizeParquetModule(module);
  } catch (error) {
    // Local import failed, try CDN fallback (needed in vite dev server)
    // Reference: https://observablehq.com/@kylebarron/geoparquet-on-the-web
    console.warn(
      '[VTableSource] Local parquet-wasm import failed, falling back to CDN version. ' +
        'This is a temporary workaround pending a better parquet module solution.',
      error
    );

    try {
      const cdnModule = await import(
        // @ts-expect-error - CDN import not recognized by TypeScript
        'https://cdn.vitessce.io/parquet-wasm@2c23652/esm/parquet_wasm.js'
      );
      await initializeParquetModule(cdnModule);
      return normalizeParquetModule(cdnModule);
    } catch (cdnError) {
      // Both imports failed, throw an error
      const localErrorMsg = error instanceof Error ? error.message : String(error);
      const cdnErrorMsg = cdnError instanceof Error ? cdnError.message : String(cdnError);
      throw new Error(
        `Failed to load parquet-wasm from both local package and CDN. Local error: ${localErrorMsg}. CDN error: ${cdnErrorMsg}`
      );
    }
  }
}

/**
 * Get the name of the index column from an Apache Arrow table.
 * In the future, this may not be needed if more metadata is included in the Zarr Attributes.
 * Reference: https://github.com/scverse/spatialdata/issues/958
 */
export function tableToIndexColumnName(arrowTable: ArrowTable): string | undefined {
  const pandasMetadata = arrowTable.schema.metadata.get('pandas');
  if (!pandasMetadata) {
    return undefined;
  }

  const pandasMetadataJson = JSON.parse(pandasMetadata) as {
    index_columns?: unknown[];
  };
  const indexColumns = pandasMetadataJson.index_columns;
  if (!Array.isArray(indexColumns) || indexColumns.length !== 1) {
    throw new Error('Expected a single index column in the pandas metadata.');
  }

  const indexCol = indexColumns[0];

  if (typeof indexCol === 'string') {
    return indexCol;
  }

  // GeoPandas ≥1.1 / pandas RangeIndex: no materialized parquet column.
  if (typeof indexCol === 'object' && indexCol !== null && 'kind' in indexCol) {
    return undefined;
  }

  throw new Error(`Unexpected pandas index_columns entry: ${JSON.stringify(indexCol)}`);
}

// If the array path starts with table/something/rest
// capture table/something.
const pluralSubElementRegex = /^tables\/([^/]*)\/(.*)$/;
const singularSubElementRegex = /^table\/([^/]*)\/(.*)$/;

const pluralRegex = /^tables\/([^/]*)$/;
const singularRegex = /^table\/([^/]*)$/;

function getTableElementPath(arrPath?: string) {
  if (arrPath) {
    // First try the plural "tables/{something}/{arr}"
    const pluralMatches = arrPath.match(pluralSubElementRegex);
    if (pluralMatches && pluralMatches.length === 3) {
      return `tables/${pluralMatches[1]}`;
    }
    // Then try the plural "tables/{something}"
    const pluralElementMatches = arrPath.match(pluralRegex);
    if (pluralElementMatches && pluralElementMatches.length === 2) {
      return `tables/${pluralElementMatches[1]}`;
    }
    // Then try the singular "table/{something}/{arr}"
    const singularMatches = arrPath.match(singularSubElementRegex);
    if (singularMatches && singularMatches.length === 3) {
      return `table/${singularMatches[1]}`;
    }
    // Finally try the singular "table/{something}"
    const singularElementMatches = arrPath.match(singularRegex);
    if (singularElementMatches && singularElementMatches.length === 2) {
      return `table/${singularElementMatches[1]}`;
    }
  }
  return ''; // TODO: throw an error?
}

function getObsPath(arrPath?: string) {
  return `${getTableElementPath(arrPath)}/obs`;
}

function getVarPath(arrPath?: string) {
  return `${getTableElementPath(arrPath)}/var`;
}

function getParquetCandidatePaths(parquetPath: string) {
  return [parquetPath, `${parquetPath}/part.0.parquet`];
}

function toUint8Array(bytes: ArrayBuffer | ArrayBufferView | null | undefined): Uint8Array | null {
  if (!bytes) {
    return null;
  }
  if (ArrayBuffer.isView(bytes)) {
    return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }
  return new Uint8Array(bytes);
}

function hasParquetMagic(bytes: Uint8Array, offset: number) {
  return (
    offset >= 0 &&
    offset + 4 <= bytes.length &&
    bytes[offset] === 0x50 &&
    bytes[offset + 1] === 0x41 &&
    bytes[offset + 2] === 0x52 &&
    bytes[offset + 3] === 0x31
  );
}

function isParquetFileBytes(bytes: Uint8Array) {
  return bytes.length >= 8 && hasParquetMagic(bytes, 0) && hasParquetMagic(bytes, bytes.length - 4);
}

function hasParquetTailMagic(bytes: Uint8Array) {
  return bytes.length >= 8 && hasParquetMagic(bytes, bytes.length - 4);
}

function toSafeNumber(value: number | bigint, label: string) {
  const n = typeof value === 'bigint' ? Number(value) : value;
  if (!Number.isSafeInteger(n) || n < 0) {
    throw new Error(`Invalid parquet ${label}: ${String(value)}`);
  }
  return n;
}

/**
 * This class is a parent class for tables, shapes, and points.
 * This is because these share functionality, for example:
 * - both shapes (the latest version) and points use parquet-based formats.
 * - both shapes (a previous version) and tables use zarr-based formats.
 * - logic for manipulating spatialdata element paths is shared across all elements.
 */
export default class SpatialDataTableSource extends AnnDataSource {
  static parquetModulePromise: Promise<ParquetModule>;
  rootAttrs: { softwareVersion: string; formatVersion: string } | null;
  // biome-ignore lint/suspicious/noExplicitAny: elementAttrs type should be a tree-ish thing
  elementAttrs: Record<string, any>;
  parquetTableBytes: Record<string, Uint8Array>;
  /**
   * Cache of fully-parsed Arrow tables for paths requested without a column
   * filter.  Avoids repeating the WASM `readParquet` + `tableFromIPC` decode
   * when the same parquet file is needed by multiple callers in sequence (e.g.
   * `inferShapesGeometryKindFromParquet`, `loadShapesIndex`, and
   * `loadPolygonShapes` all target the same file).
   */
  parquetTableCache: Record<string, Promise<ArrowTable>>;
  obsIndices: Record<string, Promise<string[]>>;
  varIndices: Record<string, Promise<string[]>>;
  varAliases: Record<string, string[]>;
  constructor(params: DataSourceParams) {
    super(params);

    // Non-table-specific properties
    if (!SpatialDataTableSource.parquetModulePromise) {
      SpatialDataTableSource.parquetModulePromise = getParquetModule();
    }

    this.rootAttrs = null;
    /**
     * This is a map of element paths to their attributes.
     */
    this.elementAttrs = {};

    // TODO: change to column-specific storage.
    this.parquetTableBytes = {};
    this.parquetTableCache = {};

    // Table-specific properties
    this.obsIndices = {};
    this.varIndices = {};
    this.varAliases = {};
  }

  // NON-TABLE-SPECIFIC METHODS

  // TODO: implement a method to load the root zmetadata?
  // This could help to determine which table annotates which elements,
  // without the need to provide the tablePath in the options.

  /**
   * This function loads the attrs for the root spatialdata object.
   * This is not the same as the attrs for a specific element.
   */
  async loadSpatialDataObjectAttrs() {
    if (this.rootAttrs) {
      return this.rootAttrs;
    }
    // Load the root attrs.
    const rootAttrs = await this.getJson('.zattrs');
    const { spatialdata_attrs } = rootAttrs;
    const { spatialdata_software_version: softwareVersion, version: formatVersion } =
      spatialdata_attrs;
    this.rootAttrs = { softwareVersion, formatVersion };
    return this.rootAttrs;
  }

  /**
   * Get the attrs for a specific element
   * (e.g., "shapes/{element_name}" or "tables/{element_name}").
   * @param elementPath
   * @returns
   */
  async loadSpatialDataElementAttrs(elementPath: string) {
    if (this.elementAttrs[elementPath]) {
      return this.elementAttrs[elementPath];
    }
    // TODO: normalize the elementPath to always end without a slash?
    // TODO: ensure that elementPath is a valid spatial element path?
    const v0_4_0_attrs = await this.getJson(`${elementPath}/.zattrs`);

    let result = v0_4_0_attrs;
    if (v0_4_0_attrs['encoding-type'] === 'anndata') {
      const attrsKeys = Object.keys(v0_4_0_attrs);
      if (['instance_key', 'region', 'region_key'].every((k) => attrsKeys.includes(k))) {
        // TODO: assert things about "spatialdata-encoding-type" and "version" values?
        // TODO: first check the "spatialdata_software_version" metadata in
        // the root of the spatialdata object? (i.e., sdata.zarr/.zattrs)
        result = v0_4_0_attrs;
      } else {
        // Prior to v0.4.0 of the spatialdata package, the spatialdata_attrs
        // lived within their own dictionary within "uns".
        const pre_v0_4_0_attrs = await this._loadDict(`${elementPath}/uns/spatialdata_attrs`, [
          'instance_key',
          'region',
          'region_key',
        ]);
        result = pre_v0_4_0_attrs;
      }
    }
    this.elementAttrs[elementPath] = result;
    return this.elementAttrs[elementPath];
  }

  /**
   *
   * @param parquetPath The path to the parquet file or directory,
   * relative to the store root.
   * @returns The parquet file bytes.
   */
  async loadParquetBytes(parquetPath: string) {
    if (this.parquetTableBytes[parquetPath]) {
      // Return the cached bytes.
      return this.parquetTableBytes[parquetPath];
    }

    for (const candidatePath of getParquetCandidatePaths(parquetPath)) {
      try {
        // Some servers return an HTML directory listing for multipart parquet
        // directories, so validate the bytes before caching or parsing them.
        const parquetBytes = await this.storeRoot.store.get(`/${candidatePath}`);
        const normalizedBytes = toUint8Array(parquetBytes);
        if (!normalizedBytes || !isParquetFileBytes(normalizedBytes)) {
          continue;
        }
        // Cache the parquet bytes.
        this.parquetTableBytes[parquetPath] = normalizedBytes;
        return normalizedBytes;
      } catch {
        // Keep probing candidate parquet paths.
      }
    }
    return null;
  }

  /**
   * Try to load only the schema bytes of a parquet file.
   * This is useful for getting the index column name without
   * loading the full table.
   * This will only work if the store supports getRange,
   * for example FetchStore.
   * Reference: https://github.com/manzt/zarrita.js/blob/c0dd684dc4da79a6f42ab2a591246947bde8d143/packages/%40zarrita-storage/src/fetch.ts#L87
   * In the future, this may not be needed if more metadata is
   * included in the Zarr Attributes.
   * Reference: https://github.com/scverse/spatialdata/issues/958
   * @param parquetPath The path to the parquet file or directory,
   * relative to the store root.
   * @returns The parquet file bytes,
   * or null if the store does not support getRange.
   */
  async loadParquetSchemaBytes(parquetPath: string) {
    const { store } = this.storeRoot;
    if (store.getRange) {
      let lastError: Error | null = null;

      for (const candidatePath of getParquetCandidatePaths(parquetPath)) {
        try {
          const footerBytes = await this.loadParquetFooterBytesForPath(candidatePath);
          if (footerBytes) return footerBytes;
        } catch (error) {
          lastError = error instanceof Error ? error : new Error(String(error));
        }
      }

      throw lastError ?? new Error(`Failed to load parquet footerLength for ${parquetPath}`);
    }
    // Store does not support getRange.
    return null;
  }

  private async loadParquetFooterBytesForPath(path: string): Promise<Uint8Array | null> {
    const { store } = this.storeRoot;
    if (!store.getRange) {
      return null;
    }
    const tailLength = 8;
    const tailBytes = await store.getRange(`/${path}`, {
      suffixLength: tailLength,
    });
    const normalizedTailBytes = toUint8Array(tailBytes);
    if (!normalizedTailBytes || !hasParquetTailMagic(normalizedTailBytes)) {
      return null;
    }

    const footerLength = new DataView(
      normalizedTailBytes.buffer,
      normalizedTailBytes.byteOffset,
      normalizedTailBytes.byteLength
    ).getInt32(0, true);

    const footerBytes = await store.getRange(`/${path}`, {
      suffixLength: footerLength + tailLength,
    });
    const normalizedFooterBytes = toUint8Array(footerBytes);
    if (
      !normalizedFooterBytes ||
      normalizedFooterBytes.length !== footerLength + tailLength ||
      !hasParquetTailMagic(normalizedFooterBytes)
    ) {
      return null;
    }
    return normalizedFooterBytes;
  }

  async loadParquetSchemaTable(parquetPath: string): Promise<ArrowTable | null> {
    const schemaBytes = await this.loadParquetSchemaBytes(parquetPath);
    if (!schemaBytes) {
      return null;
    }
    const { readSchema } = await SpatialDataTableSource.parquetModulePromise;
    const wasmSchema = readSchema(schemaBytes);
    return tableFromIPC(wasmSchema.intoIPCStream());
  }

  private async loadParquetPartMetadata(path: string): Promise<ParquetPartMetadata | null> {
    const { readMetadata, readSchema } = await SpatialDataTableSource.parquetModulePromise;
    if (!readMetadata) {
      return null;
    }
    const schemaBytes = await this.loadParquetFooterBytesForPath(path);
    if (!schemaBytes) {
      return null;
    }
    const schemaTable = await tableFromIPC(readSchema(schemaBytes).intoIPCStream());
    return {
      path,
      schema: schemaTable.schema,
      schemaBytes,
      metadata: readMetadata(schemaBytes),
    };
  }

  async loadParquetDatasetMetadata(parquetPath: string): Promise<ParquetDatasetMetadata | null> {
    const { readMetadata } = await SpatialDataTableSource.parquetModulePromise;
    const { store } = this.storeRoot;
    if (!readMetadata || !store.getRange) {
      return null;
    }

    const directPart = await this.loadParquetPartMetadata(parquetPath);
    const parts: ParquetPartMetadata[] = [];
    if (directPart) {
      parts.push(directPart);
    } else {
      for (let partIndex = 0; ; partIndex++) {
        const part = await this.loadParquetPartMetadata(`${parquetPath}/part.${partIndex}.parquet`);
        if (!part) {
          break;
        }
        parts.push(part);
      }
    }

    if (parts.length === 0) {
      return null;
    }

    const numRowsByPart = parts.map((part) => part.metadata.fileMetadata().numRows());
    const numRowGroupsByPart = parts.map((part) => part.metadata.numRowGroups());
    const numRowsPerGroupByPart = parts.map((part) =>
      part.metadata.numRowGroups() > 0 ? part.metadata.rowGroup(0).numRows() : 0
    );
    const rowGroupRows = parts.flatMap((part) =>
      Array.from({ length: part.metadata.numRowGroups() }, (_value, rowGroupIndex) =>
        part.metadata.rowGroup(rowGroupIndex).numRows()
      )
    );
    return {
      totalNumRows: numRowsByPart.reduce((acc, cur) => acc + cur, 0),
      totalNumRowGroups: numRowGroupsByPart.reduce((acc, cur) => acc + cur, 0),
      numRowsByPart,
      numRowGroupsByPart,
      numRowsPerGroupByPart,
      rowGroupRows,
      schema: parts[0]?.schema ?? null,
      parts,
    };
  }

  async canLoadParquetRowGroups(): Promise<boolean> {
    const module = await SpatialDataTableSource.parquetModulePromise;
    return (
      typeof module.readMetadata === 'function' && typeof module.readParquetRowGroup === 'function'
    );
  }

  async loadParquetRowGroupByGroupIndex(
    parquetPath: string,
    rowGroupIndex: number
  ): Promise<ArrowTable | null> {
    const { readParquetRowGroup } = await SpatialDataTableSource.parquetModulePromise;
    const { store } = this.storeRoot;
    if (!readParquetRowGroup || !store.getRange) {
      return null;
    }
    const dataset = await this.loadParquetDatasetMetadata(parquetPath);
    if (!dataset || rowGroupIndex < 0 || rowGroupIndex >= dataset.totalNumRowGroups) {
      return null;
    }

    let cumulativeRowGroups = 0;
    for (const part of dataset.parts) {
      const partRowGroupCount = part.metadata.numRowGroups();
      if (rowGroupIndex >= cumulativeRowGroups + partRowGroupCount) {
        cumulativeRowGroups += partRowGroupCount;
        continue;
      }
      const relativeRowGroupIndex = rowGroupIndex - cumulativeRowGroups;
      const rowGroup = part.metadata.rowGroup(relativeRowGroupIndex);
      const offset = toSafeNumber(rowGroup.fileOffset(), 'row-group file offset');
      const length = toSafeNumber(rowGroup.compressedSize(), 'row-group compressed size');
      const bytes = await store.getRange(`/${part.path}`, { offset, length });
      const rowGroupBytes = toUint8Array(bytes);
      if (!rowGroupBytes) {
        return null;
      }
      return tableFromIPC(
        readParquetRowGroup(part.schemaBytes, rowGroupBytes, relativeRowGroupIndex).intoIPCStream()
      );
    }
    return null;
  }

  async loadParquetRowGroupColumnExtent(
    parquetPath: string,
    columnName: string,
    rowGroupIndex: number
  ): Promise<{ min: number | null; max: number | null } | null> {
    const table = await this.loadParquetRowGroupByGroupIndex(parquetPath, rowGroupIndex);
    const column = table?.getChild(columnName);
    if (!column || column.length === 0) {
      return null;
    }
    const min = column.get(0);
    const max = column.get(column.length - 1);
    return {
      min: typeof min === 'number' ? min : null,
      max: typeof max === 'number' ? max : null,
    };
  }

  /**
   * Get the index column from a parquet table.
   * @param parquetPath A path to a parquet file (or directory).
   * @returns A promise for a column, or null.
   */
  async loadParquetTableIndex(parquetPath: string) {
    const arrowTable = await this.loadParquetTable(parquetPath);
    const indexColumnName = tableToIndexColumnName(arrowTable);
    if (!indexColumnName) {
      return null;
    }
    return arrowTable.getChild(indexColumnName);
  }

  /**
   * TODO: change implementation so that subsets of
   * columns can be loaded if the whole table is not needed.
   * Will first need to load the table schema.
   * @param parquetPath A path to a parquet file (or directory).
   * @param columns An optional list of column names to load.
   * @returns
   */
  async loadParquetTable(parquetPath: string, columns?: string[]): Promise<ArrowTable> {
    // When no column filter is requested, return a shared promise so that
    // concurrent or sequential callers for the same file share one WASM decode.
    if (!columns?.length && parquetPath in this.parquetTableCache) {
      return this.parquetTableCache[parquetPath];
    }

    const tablePromise = this._loadParquetTableUncached(parquetPath, columns);

    if (!columns?.length) {
      this.parquetTableCache[parquetPath] = tablePromise;
    }

    return tablePromise;
  }

  private async _loadParquetTableUncached(
    parquetPath: string,
    columns?: string[]
  ): Promise<ArrowTable> {
    const { readParquet, readSchema } = await SpatialDataTableSource.parquetModulePromise;

    const options = {
      columns,
    };

    let indexColumnName: string | undefined;

    if (columns?.length) {
      // If columns are specified, we also want to ensure that the index column is included.
      // Otherwise, the user wants the full table anyway.

      // We first try to load the schema bytes to determine the index column name.
      // Perhaps in the future SpatialData can store the index column name
      // in the .zattrs so that we do not need to load the schema first,
      // since only certain stores such as FetchStores support getRange.
      // Reference: https://github.com/scverse/spatialdata/issues/958
      try {
        const schemaBytes = await this.loadParquetSchemaBytes(parquetPath);
        if (schemaBytes) {
          const wasmSchema = readSchema(schemaBytes);
          const arrowTableForSchema = await tableFromIPC(wasmSchema.intoIPCStream());
          indexColumnName = tableToIndexColumnName(arrowTableForSchema);
        }
      } catch (e: unknown) {
        // If we fail to load the schema bytes, we can proceed to try to load the full table bytes,
        // for instance if range requests are not supported but the full table can be loaded.
        //@ts-expect-error e.message not a property of e: unknown
        console.warn(`Failed to load parquet schema bytes for ${parquetPath}: ${e.message}`);
      }
    }
    // Load the full table bytes.

    // TODO: can we avoid loading the full table bytes
    // if we only need a subset of columns?
    // For example, if the store supports
    // getRange like above to get the schema bytes.
    // See https://github.com/kylebarron/parquet-wasm/issues/758
    let parquetBytes = await this.loadParquetBytes(parquetPath);
    if (!parquetBytes) {
      throw new Error('Failed to load parquet data from store.');
    }
    if (!ArrayBuffer.isView(parquetBytes)) {
      // This is required because in vitessce-python the
      // experimental.invoke store wrapper can return an ArrayBuffer,
      // but readParquet expects a Uint8Array.
      parquetBytes = new Uint8Array(parquetBytes);
    }

    if (columns?.length && !indexColumnName) {
      // The user requested specific columns, but we did not load the schema bytes
      // to successfully get the index column name.
      // Here we try again to get the index column name, but this
      // time from the full table bytes (rather than only the schema-bytes).
      const wasmSchema = readSchema(parquetBytes);
      /** @type {import('apache-arrow').Table} */
      const arrowTableForSchema = await tableFromIPC(wasmSchema.intoIPCStream());
      indexColumnName = tableToIndexColumnName(arrowTableForSchema);
    }

    if (options.columns?.length && indexColumnName) {
      options.columns = [...options.columns, indexColumnName];
    }

    const wasmTable = readParquet(parquetBytes, options);
    /** @type {import('apache-arrow').Table} */
    const arrowTable = await tableFromIPC(wasmTable.intoIPCStream());
    return arrowTable;
  }

  // TABLE-SPECIFIC METHODS

  /**
   * Class method for loading the obs index.
   * @param path
   * @returns An promise for a zarr array containing the indices.
   */
  async loadObsIndex(path?: string) {
    const obsPath = getObsPath(path);
    const { _index } = await this.getJson(`${obsPath}/.zattrs`);
    let indexPath: string | undefined;
    if (_index && typeof _index === 'string') {
      indexPath = `${obsPath}/${_index}`;
    }

    const {
      instance_key: instanceKey,
      // TODO: filter table index by region and element type.
      // region_key: regionKey,
      // region,
    } = await this.loadSpatialDataElementAttrs(getTableElementPath(path));

    if (instanceKey !== undefined && instanceKey !== null) {
      // Use a specific instanceKey column for the index if
      // defined according to spatialdata_attrs metadata.
      indexPath = `${obsPath}/${instanceKey}`;
    }

    if (indexPath && indexPath in this.obsIndices) {
      return this.obsIndices[indexPath];
    }
    if (!indexPath) {
      throw new Error(`No index path found for obs index at ${path}`);
    }
    this.obsIndices[indexPath] = this._loadColumn(indexPath).then((values) =>
      // not clear this extra pass is useful... does it exist just to satisfy types?
      Array.from(values, (value) => (value === null || value === undefined ? '' : String(value)))
    );
    return this.obsIndices[indexPath];
  }

  /**
   * Class method for loading the var index.
   * @param path
   * @returns An promise for a zarr array containing the indices.
   */
  async loadVarIndex(path?: string) {
    //PJT: made the signature async - was already returning a promise, that seems clearer.
    const varPath = getVarPath(path);
    if (varPath in this.varIndices) {
      return this.varIndices[varPath];
    }
    this.varIndices[varPath] = this.getJson(`${varPath}/.zattrs`)
      .then(({ _index }) => this.getFlatArrDecompressed(`${varPath}/${_index}`))
      .then((values) =>
        Array.from(values, (value) => (value === null || value === undefined ? '' : String(value)))
      );
    return this.varIndices[varPath];
  }

  /**
   * Class method for loading the var alias.
   * @param varPath
   * @param matrixPath
   * @returns An promise for a zarr array containing the aliased names.
   */
  async loadVarAlias(varPath: string, matrixPath: string) {
    if (varPath in this.varAliases) {
      return this.varAliases[varPath];
    }
    const [varAliasData] = (await this.loadVarColumns([varPath])) as [TableColumnData | undefined];
    if (!varAliasData) {
      throw new Error(`Failed to load var alias at ${varPath}`);
    }
    this.varAliases[varPath] = Array.from(varAliasData, (value) =>
      value === null || value === undefined ? '' : String(value)
    );
    const index = await this.loadVarIndex(matrixPath);
    this.varAliases[varPath] = Array.from(this.varAliases[varPath], (val, ind) => {
      const indexValue = index[ind];
      const suffix = indexValue === null || indexValue === undefined ? '' : String(indexValue);
      return val ? val.concat(` (${suffix})`) : suffix;
    });
    return this.varAliases[varPath];
  }
}
