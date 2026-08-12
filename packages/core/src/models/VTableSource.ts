// this is a direct copy of the Vitessce implementation, with changes mostly to make it more normal TypeScript.

import { type Table as ArrowTable, tableFromIPC } from 'apache-arrow';
import {
  getParquetModule,
  type ParquetModule,
  type ParquetRowGroupReadOptions,
  type ParquetWasmMetadata,
  supportsParquetStreaming,
} from '../parquetWasmLoader.js';
import type { TableColumnData } from '../types';
import type { DataSourceParams } from '../Vutils';
import AnnDataSource from './VAnnDataSource';

export type { ParquetRowGroupReadOptions };

function parquetColumnValueToNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'bigint') {
    return Number(value);
  }
  return null;
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
  /**
   * Remembers parquet part layout per path — single file vs. `part.N.parquet`
   * directory, and the per-part metadata — so the probe sequence (see
   * {@link loadParquetDatasetMetadata}) runs once, not on every one of the ~20
   * calls a single points load makes. Only real datasets are held; nulls/failures
   * are evicted.
   */
  parquetDatasetMetadataCache: Map<string, Promise<ParquetDatasetMetadata | null>>;
  /** Part paths discovered by whole-file probing — the transport-independent
   * fallback used when a store has no range support, so the layout is still
   * resolved once rather than per call. */
  parquetPartPathsCache: Map<string, Promise<string[]>>;
  /**
   * Morton min/max per row group — avoids re-decoding row groups during bisect.
   *
   * Holds the in-flight PROMISE, not the settled value. Caching only the result
   * dedups nothing while the read is running, and this index is built under exactly
   * that load: every viewport tile bisects concurrently over the same row groups, so
   * each one used to start its own full row-group fetch for an entry the others were
   * already fetching.
   */
  rowGroupColumnExtentCache: Map<
    string,
    Promise<{ min: number | null; max: number | null } | null>
  >;
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
    this.parquetDatasetMetadataCache = new Map();
    this.parquetPartPathsCache = new Map();
    this.rowGroupColumnExtentCache = new Map();

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
  /**
   * The candidate paths to try for "the parquet file at `parquetPath`", best
   * first.
   *
   * Blind, the order has to be [directory, part.0] — you cannot know which it is
   * without asking. But once the layout IS known, leading with the directory means
   * a guaranteed-useless request every time: an HTML listing to be rejected by the
   * magic check on a static server, a 500 on MDV. A PEEK at the resolved layout
   * (never resolving it — see {@link loadParquetSchemaBytes}) lets a known
   * multipart element go straight to its first real part.
   */
  private async orderedParquetCandidatePaths(parquetPath: string): Promise<string[]> {
    const pending = this.parquetDatasetMetadataCache.get(parquetPath);
    if (pending) {
      try {
        const firstPartPath = (await pending)?.parts[0]?.path;
        if (firstPartPath && firstPartPath !== parquetPath) {
          return [firstPartPath];
        }
      } catch {
        // A peek must never be load-bearing. The cached resolution rejects (and
        // evicts itself) on a transient failure; that means "layout unknown", not
        // "this path is broken" — fall back to the blind candidate order rather
        // than throwing out of the caller's probe loop.
      }
    }
    return getParquetCandidatePaths(parquetPath);
  }

  async loadParquetBytes(parquetPath: string) {
    if (this.parquetTableBytes[parquetPath]) {
      // Return the cached bytes.
      return this.parquetTableBytes[parquetPath];
    }

    for (const candidatePath of await this.orderedParquetCandidatePaths(parquetPath)) {
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
      // An ALREADY-resolved layout carries each part's footer bytes — exactly what
      // this returns. Reuse them rather than re-walking the candidate paths: that
      // walk probes the DIRECTORY path first every time, and this runs on every
      // schema/column resolution, so it kept re-issuing the directory read (and
      // MDV's 500) long after the layout was known.
      //
      // Deliberately a PEEK, not a call: resolving the layout from here would probe
      // the whole part sequence, so an element whose footer `readMetadata` cannot
      // parse (and which therefore has no layout) would pay for both walks instead
      // of just this one.
      const pending = this.parquetDatasetMetadataCache.get(parquetPath);
      if (pending) {
        try {
          const schemaBytes = (await pending)?.parts[0]?.schemaBytes;
          if (schemaBytes) {
            return schemaBytes;
          }
        } catch {
          // A rejected layout means "unknown", not "unresolvable": fall through to
          // the candidate walk below rather than failing the whole resolution.
        }
      }

      let lastError: Error | null = null;

      for (const candidatePath of await this.orderedParquetCandidatePaths(parquetPath)) {
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

  private readParquetFooterBytesFromFileBytes(bytes: Uint8Array): Uint8Array | null {
    if (bytes.length < 8) {
      return null;
    }
    const footerLength = new DataView(
      bytes.buffer,
      bytes.byteOffset + bytes.length - 8,
      8
    ).getInt32(0, true);
    const totalFooterSize = footerLength + 8;
    if (totalFooterSize <= 0 || totalFooterSize > bytes.length) {
      return null;
    }
    return bytes.subarray(bytes.length - totalFooterSize);
  }

  private async loadParquetPartMetadataFromFullFile(
    path: string
  ): Promise<ParquetPartMetadata | null> {
    const { readMetadata, readSchema } = await SpatialDataTableSource.parquetModulePromise;
    if (!readMetadata) {
      return null;
    }
    const fileBytes = await this.loadParquetFileBytesAtPath(path);
    if (!fileBytes) {
      return null;
    }
    const schemaBytes = this.readParquetFooterBytesFromFileBytes(fileBytes);
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

  private async countRowsFromFullParquetFile(path: string): Promise<number> {
    const fileBytes = await this.loadParquetFileBytesAtPath(path);
    if (!fileBytes) {
      return 0;
    }
    const { readParquet } = await SpatialDataTableSource.parquetModulePromise;
    const table = await tableFromIPC(readParquet(fileBytes, { columns: ['x'] }).intoIPCStream());
    return table.numRows;
  }

  protected async resolveParquetRowCount(parquetPath: string): Promise<number> {
    // The cached layout answers this outright on any range-capable store; the
    // whole-file paths below are the fallback for stores without range support.
    // (This is where the "lots of 404s for part.N" TODO lived — the enumeration is
    // now shared and memoized rather than repeated per call.)
    const datasetMetadata = await this.loadParquetDatasetMetadata(parquetPath);
    if (datasetMetadata?.totalNumRows) {
      return datasetMetadata.totalNumRows;
    }

    const directPart = await this.loadParquetPartMetadataFromFullFile(parquetPath);
    if (directPart) {
      return directPart.metadata.fileMetadata().numRows();
    }

    // Same part set the loop here used to rediscover: every probe involved goes
    // through the magic-checked `loadParquetFileBytesAtPath`, so sharing the
    // memoized discovery finds exactly what enumerating inline did.
    const partPaths = await this.discoverMultipartPartPaths(parquetPath);
    let totalRows = 0;
    let foundPart = false;
    for (const partPath of partPaths) {
      const part = await this.loadParquetPartMetadataFromFullFile(partPath);
      if (part) {
        foundPart = true;
        totalRows += part.metadata.fileMetadata().numRows();
        continue;
      }
      // A part whose footer will not parse still contributes rows; fall back to
      // counting a single column.
      const columnCount = await this.countRowsFromFullParquetFile(partPath);
      if (columnCount > 0) {
        foundPart = true;
        totalRows += columnCount;
      }
    }
    if (foundPart) {
      return totalRows;
    }

    return this.countRowsFromFullParquetFile(parquetPath);
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

  /**
   * Probe one path as a single parquet file, resolving to `null` — never
   * throwing — when it is not one.
   *
   * `parquetPath` for a points/shapes element is a DIRECTORY of `part.N.parquet`
   * files as often as it is a single file, and servers disagree on how they
   * answer a range read of a directory: a static server 404s (the store maps that
   * to `undefined` → `null`), but MDV's Flask returns **500** `[Errno 21] Is a
   * directory`, S3 can 403, and some return a `200` body that fails the parquet
   * magic check. The zarrita store throws on every non-2xx that is not 404, so
   * without this guard a single misbehaving directory response escaped all the way
   * out of {@link loadParquetDatasetMetadata} — the direct probe threw before the
   * `part.N` enumeration ever ran, and the element wedged. Every one of those
   * responses means the same thing here: "not a single parquet file at this path",
   * so enumerate parts instead. This mirrors the already-tolerant
   * {@link loadParquetFileBytesAtPath} and {@link loadParquetSchemaBytes}.
   */
  private async probeParquetPartMetadata(path: string): Promise<ParquetPartMetadata | null> {
    try {
      return await this.loadParquetPartMetadata(path);
    } catch {
      return null;
    }
  }

  /**
   * Resolve whether `parquetPath` is a single parquet file or a directory of
   * `part.N.parquet` files, plus the per-part metadata — remembering the answer.
   *
   * Part discovery costs real requests every time it runs: a probe of the
   * directory path itself (which servers answer inconsistently — a 404, or the
   * MDV 500, see {@link probeParquetPartMetadata}), plus one 404 past the final
   * part to find the end of the sequence. For a read-only store the layout never
   * changes, yet a single points load calls this ~20 times (row counts, tiling,
   * row-group extents, the streaming reader, …), so uncached it repeated that
   * whole probe sequence over and over — the trailing 404s and repeated directory
   * 500s visible in the network tab.
   *
   * The promise is cached so concurrent callers share one probe, but only a real
   * dataset is remembered: a `null` resolution or a rejection is evicted. Now that
   * {@link probeParquetPartMetadata} turns a failed probe into `null` rather than a
   * throw, a transient all-probes-failed must not be allowed to stick and
   * permanently mark a real dataset as absent — and a genuine not-a-dataset path
   * is cheap to re-probe.
   */
  loadParquetDatasetMetadata(parquetPath: string): Promise<ParquetDatasetMetadata | null> {
    const cached = this.parquetDatasetMetadataCache.get(parquetPath);
    if (cached) {
      return cached;
    }
    const promise = this.loadParquetDatasetMetadataUncached(parquetPath).then(
      (result) => {
        if (result === null) {
          this.evictIfCurrent(this.parquetDatasetMetadataCache, parquetPath, promise);
        }
        return result;
      },
      (error) => {
        this.evictIfCurrent(this.parquetDatasetMetadataCache, parquetPath, promise);
        throw error;
      }
    );
    this.parquetDatasetMetadataCache.set(parquetPath, promise);
    return promise;
  }

  /** Drop a cache entry only if it still holds `promise` — a later call that
   * superseded it (e.g. after an eviction) must not be clobbered by an earlier
   * promise's late resolution. */
  private evictIfCurrent<V>(
    cache: Map<string, Promise<V>>,
    key: string,
    promise: Promise<V>
  ): void {
    if (cache.get(key) === promise) {
      cache.delete(key);
    }
  }

  private async loadParquetDatasetMetadataUncached(
    parquetPath: string
  ): Promise<ParquetDatasetMetadata | null> {
    const { readMetadata } = await SpatialDataTableSource.parquetModulePromise;
    const { store } = this.storeRoot;
    if (!readMetadata || !store.getRange) {
      return null;
    }

    const directPart = await this.probeParquetPartMetadata(parquetPath);
    const parts: ParquetPartMetadata[] = [];
    if (directPart) {
      parts.push(directPart);
    } else {
      for (let partIndex = 0; ; partIndex++) {
        const part = await this.probeParquetPartMetadata(
          `${parquetPath}/part.${partIndex}.parquet`
        );
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

  /**
   * Absolute http(s) URL for a store-relative path, or null when the store is
   * not URL-backed.
   *
   * The streaming parquet reader fetches on its own rather than through the
   * store, so it only applies when the store resolves to a plain URL — the same
   * capability-check shape as `store.getRange`. Custom, prefixed and in-memory
   * stores return null here and keep the byte-oriented path.
   */
  protected resolveStoreUrl(path: string): string | null {
    const base = (this.storeRoot.store as { url?: string | URL }).url;
    if (base === undefined || base === null) {
      return null;
    }
    try {
      const baseHref = typeof base === 'string' ? base : base.href;
      const rootHref = baseHref.endsWith('/') ? baseHref : `${baseHref}/`;
      const resolved = new URL(path.replace(/^\/+/, ''), rootHref);
      // The reader fetches directly; anything the browser will not range-read
      // (file:, blob:, custom schemes) has to fall back.
      return resolved.protocol === 'http:' || resolved.protocol === 'https:' ? resolved.href : null;
    } catch {
      return null;
    }
  }

  /** Whether the URL-backed streaming reader is usable for this store+runtime. */
  protected async canStreamParquetByUrl(): Promise<boolean> {
    if (!supportsParquetStreaming()) {
      return false;
    }
    const module = await SpatialDataTableSource.parquetModulePromise;
    return typeof module.ParquetFile?.fromUrl === 'function';
  }

  /**
   * Verify a server actually serves the range shapes the streaming reader needs,
   * before handing it the URL.
   *
   * The reader fetches on its own and treats a refused range as unreachable: it
   * panics with `RuntimeError: unreachable` AND leaves its promise unsettled, so
   * the failure can be neither caught nor awaited. Probing first is the only way
   * to decline cleanly instead of relying on the stall watchdog.
   *
   * It needs two shapes (observed by logging a real scan):
   *   - `bytes=-N`  suffix ranges, to read the footer
   *   - `bytes=A-B` bounded ranges, to read column chunks
   *
   * Suffix ranges are the fragile one — plenty of static servers answer 416.
   * The rest of this class tolerates that by falling back to whole-file reads
   * (see `loadParquetFooterBytesForPath`), which is why such a server otherwise
   * looks healthy.
   *
   * Cached per origin: the answer is a property of the server, not the file.
   */
  private static readonly rangeProbeByOrigin = new Map<string, Promise<boolean>>();

  protected serverSupportsStreamingRanges(url: string): Promise<boolean> {
    let origin: string;
    try {
      origin = new URL(url).origin;
    } catch {
      return Promise.resolve(false);
    }
    const cached = SpatialDataTableSource.rangeProbeByOrigin.get(origin);
    if (cached) {
      return cached;
    }
    // A *definitive* answer — the server replied and we read its status — is a
    // property of the server and caches for the session. A thrown fetch is not
    // an answer: caching it would let one blip (a dropped connection, a reload
    // race, a momentarily unreachable server) demote every element on the origin
    // to the whole-file path for the rest of the page's life, which reads as a
    // non-deterministic "sometimes points/counts never settle".
    let definitive = true;
    const probe = (async () => {
      try {
        // `no-store` is essential, not a nicety. These files are served with a
        // long max-age, so once any whole-file read has populated the HTTP
        // cache the browser answers suffix ranges itself and a cached probe
        // reports success for a server that actually returns 416. The reader
        // then works only until the entry is evicted, and panics after that.
        // Probe the server so the decision is a property of the server alone.
        const [suffix, bounded] = await Promise.all([
          fetch(url, { headers: { Range: 'bytes=-8' }, cache: 'no-store' }),
          fetch(url, { headers: { Range: 'bytes=0-7' }, cache: 'no-store' }),
        ]);
        // A 200 means the server ignored Range and sent the whole body; the
        // reader would then compute offsets against the wrong window.
        if (suffix.status !== 206 || bounded.status !== 206) {
          return false;
        }
        const [suffixBytes, boundedBytes] = await Promise.all([
          suffix.arrayBuffer(),
          bounded.arrayBuffer(),
        ]);
        return suffixBytes.byteLength === 8 && boundedBytes.byteLength === 8;
      } catch {
        definitive = false;
        return false;
      }
    })();
    probe.then(() => {
      if (!definitive && SpatialDataTableSource.rangeProbeByOrigin.get(origin) === probe) {
        SpatialDataTableSource.rangeProbeByOrigin.delete(origin);
      }
    });
    SpatialDataTableSource.rangeProbeByOrigin.set(origin, probe);
    return probe;
  }

  /**
   * Fetch compressed row-group bytes via range read (no parquet decode on the caller thread).
   */
  protected async readParquetRowGroupBytesByGroupIndex(
    parquetPath: string,
    rowGroupIndex: number
  ): Promise<{
    schemaBytes: Uint8Array;
    rowGroupBytes: Uint8Array;
    rowGroupIndex: number;
    globalRowGroupIndex: number;
  } | null> {
    const { store } = this.storeRoot;
    if (!store.getRange) {
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
      return {
        // A COPY, deliberately. These chunks are posted to the points worker with
        // their buffers TRANSFERRED, which detaches them here — so handing out the
        // cached metadata's own footer buffer would detach the cache on first use,
        // and every later row group would post an already-detached buffer
        // (`DataCloneError`, killing the progressive preload and dropping the
        // element onto whole-file reads). The chunk owns its bytes; the cache keeps
        // its own. Footers are small next to the row-group payload, and structured
        // -cloning instead of transferring would copy just the same.
        schemaBytes: new Uint8Array(part.schemaBytes),
        rowGroupBytes,
        rowGroupIndex: relativeRowGroupIndex,
        globalRowGroupIndex: rowGroupIndex,
      };
    }
    return null;
  }

  protected async readParquetRowGroupsBytesCapped(
    parquetPath: string,
    maxRows: number
  ): Promise<
    Array<{
      schemaBytes: Uint8Array;
      rowGroupBytes: Uint8Array;
      rowGroupIndex: number;
    }>
  > {
    const dataset = await this.loadParquetDatasetMetadata(parquetPath);
    if (!dataset || dataset.totalNumRowGroups <= 0) {
      return [];
    }

    const chunks: Array<{
      schemaBytes: Uint8Array;
      rowGroupBytes: Uint8Array;
      rowGroupIndex: number;
    }> = [];
    let accumulated = 0;
    for (let rowGroupIndex = 0; rowGroupIndex < dataset.totalNumRowGroups; rowGroupIndex += 1) {
      if (accumulated >= maxRows) {
        break;
      }
      const chunk = await this.readParquetRowGroupBytesByGroupIndex(parquetPath, rowGroupIndex);
      if (!chunk) {
        continue;
      }
      chunks.push(chunk);
      const rowCount = dataset.rowGroupRows[rowGroupIndex];
      if (typeof rowCount === 'number' && Number.isFinite(rowCount)) {
        accumulated += rowCount;
      } else {
        accumulated = maxRows;
      }
    }
    return chunks;
  }

  /**
   * Row-group and part byte payloads for worker-side parquet decode.
   *
   * Part bytes are WHOLE FILES — for a points element that is the entire dataset
   * (100MB+), so fetching them when the caller will not read them is the single
   * most expensive mistake this class can make. Most callers pass either the row
   * groups or the parts to the worker, never both, so parts are skipped by default
   * once row groups are in hand. Only a caller that genuinely needs parts AS A
   * FALLBACK ALONGSIDE row groups — i.e. it hands both to the worker because the
   * row-group decode may come back unusable, i.e. a dictionary column — sets
   * {@link partsAlongsideRowGroups}.
   */
  protected async readParquetWorkerPayload(
    parquetPath: string,
    options: {
      maxRows: number;
      fullPartsForFallback?: boolean;
      /** When false (default), only part bytes are fetched for worker decode. */
      includeRowGroups?: boolean;
      /**
       * Fetch whole-part bytes EVEN WHEN row groups were returned, because the
       * caller passes both to the worker and cannot know in advance which it will
       * need. Costs a full-dataset download — set it only when the row-group
       * decode can genuinely fail to produce what the caller wants.
       */
      partsAlongsideRowGroups?: boolean;
    }
  ): Promise<{
    rowGroups: Array<{
      schemaBytes: Uint8Array;
      rowGroupBytes: Uint8Array;
      rowGroupIndex: number;
    }>;
    parts: Uint8Array[];
  }> {
    const includeRowGroups = options.includeRowGroups === true;
    const canUseRowGroups = includeRowGroups && (await this.canLoadParquetRowGroups());
    const rowGroups = canUseRowGroups
      ? await this.readParquetRowGroupsBytesCapped(parquetPath, options.maxRows)
      : [];
    if (rowGroups.length > 0 && options.partsAlongsideRowGroups !== true) {
      return { rowGroups, parts: [] };
    }
    const partsMaxRows = options.fullPartsForFallback ? Number.POSITIVE_INFINITY : options.maxRows;
    const { parts } = await this.readParquetDatasetBytesCapped(parquetPath, partsMaxRows);
    return { rowGroups, parts };
  }

  async loadParquetRowGroupByGroupIndex(
    parquetPath: string,
    rowGroupIndex: number,
    readOptions?: ParquetRowGroupReadOptions
  ): Promise<ArrowTable | null> {
    const { readParquetRowGroup } = await SpatialDataTableSource.parquetModulePromise;
    if (!readParquetRowGroup) {
      return null;
    }
    const chunk = await this.readParquetRowGroupBytesByGroupIndex(parquetPath, rowGroupIndex);
    if (!chunk) {
      return null;
    }
    return tableFromIPC(
      readParquetRowGroup(
        chunk.schemaBytes,
        chunk.rowGroupBytes,
        chunk.rowGroupIndex,
        readOptions
      ).intoIPCStream()
    );
  }

  /**
   * First and last value of a column within one row group — the sorted-order index
   * the Morton row-group bisect searches.
   *
   * **This should be reading the row group's column statistics**, which parquet
   * writers already put in the footer we have parsed: `min`/`max` are sitting there,
   * exact, for nothing. Instead each call range-reads the row group's bytes (every
   * column, ~2MB on a real transcripts artifact) and decodes it twice — once for the
   * first row, once for the last. Building the index for a 245-row-group file that
   * way can fetch the whole file to recover ~4KB of boundary values.
   *
   * It is written this way because the **vendored parquet-wasm build exposes no
   * statistics accessor**: `RowGroupMetaData` offers only `numRows`/`fileOffset`/
   * `compressedSize`/`column`, and `ColumnChunkMetaData` offers no `statistics()`.
   * Fixing it properly needs either a wasm rebuild that exposes statistics or a
   * minimal Thrift read of the footer we already hold — see
   * `docs/plans/points-morton-tiled-viewport-loading.md`.
   */
  async loadParquetRowGroupColumnExtent(
    parquetPath: string,
    columnName: string,
    rowGroupIndex: number
  ): Promise<{ min: number | null; max: number | null } | null> {
    const cacheKey = `${parquetPath}::${rowGroupIndex}::${columnName}`;
    const cached = this.rowGroupColumnExtentCache.get(cacheKey);
    if (cached) {
      return cached;
    }
    const pending = this.readParquetRowGroupColumnExtent(parquetPath, columnName, rowGroupIndex);
    this.rowGroupColumnExtentCache.set(cacheKey, pending);
    // A failed probe must not be cached as a permanent "no extent" — that would
    // strand the bisect on a transient network error for the life of the source.
    pending
      .then((extent) => {
        if (extent === null && this.rowGroupColumnExtentCache.get(cacheKey) === pending) {
          this.rowGroupColumnExtentCache.delete(cacheKey);
        }
      })
      .catch(() => {
        if (this.rowGroupColumnExtentCache.get(cacheKey) === pending) {
          this.rowGroupColumnExtentCache.delete(cacheKey);
        }
      });
    return pending;
  }

  private async readParquetRowGroupColumnExtent(
    parquetPath: string,
    columnName: string,
    rowGroupIndex: number
  ): Promise<{ min: number | null; max: number | null } | null> {
    const dataset = await this.loadParquetDatasetMetadata(parquetPath);
    const rowCount = dataset?.rowGroupRows?.[rowGroupIndex];
    if (!rowCount) {
      return null;
    }
    const columnOptions: ParquetRowGroupReadOptions = { columns: [columnName] };
    const minTable = await this.loadParquetRowGroupByGroupIndex(parquetPath, rowGroupIndex, {
      ...columnOptions,
      limit: 1,
    });
    const minColumn = minTable?.getChild(columnName);
    if (!minColumn || minColumn.length === 0) {
      return null;
    }
    let maxValue: number | null = parquetColumnValueToNumber(minColumn.get(0));
    if (rowCount > 1) {
      const maxTable = await this.loadParquetRowGroupByGroupIndex(parquetPath, rowGroupIndex, {
        ...columnOptions,
        offset: rowCount - 1,
        limit: 1,
      });
      const maxColumn = maxTable?.getChild(columnName);
      if (maxColumn && maxColumn.length > 0) {
        maxValue = parquetColumnValueToNumber(maxColumn.get(0));
      }
    }
    return {
      min: parquetColumnValueToNumber(minColumn.get(0)),
      max: maxValue,
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

  /**
   * The `part.N.parquet` paths of a multipart directory, or `[]` for a single
   * parquet file.
   *
   * This is the SECOND way the codebase derives "how many parts are there" —
   * {@link loadParquetDatasetMetadata} is the first. They differ only in transport:
   * that one range-reads footers (needs `store.getRange`), this one fetches whole
   * files (works on any store), which is why both exist. But they answer the same
   * question, so when the metadata already knows the layout this must not re-probe:
   * it was enumerating `part.0`, `part.1`, … again — over WHOLE-FILE gets — even for
   * an element the metadata had already identified as a single file, which is where
   * the duplicate trailing 404s came from.
   *
   * Falls back to probing only when the metadata is unavailable (a store without
   * range support), and memoizes that fallback too. An empty result is not cached,
   * for the same reason a null dataset is not: it is indistinguishable from a
   * transient failure to read part 0.
   */
  private async discoverMultipartPartPaths(parquetPath: string): Promise<string[]> {
    // Cached, so this is free once any caller has resolved the layout.
    const dataset = await this.loadParquetDatasetMetadata(parquetPath);
    if (dataset?.parts.length) {
      // A single part AT the requested path means "not a directory" — the same
      // answer the probe loop below reaches by finding no `part.0.parquet`.
      const isSingleFile = dataset.parts.length === 1 && dataset.parts[0]?.path === parquetPath;
      return isSingleFile ? [] : dataset.parts.map((part) => part.path);
    }

    const cached = this.parquetPartPathsCache.get(parquetPath);
    if (cached) {
      return cached;
    }
    const promise = (async () => {
      const partPaths: string[] = [];
      for (let partIndex = 0; ; partIndex += 1) {
        const partPath = `${parquetPath}/part.${partIndex}.parquet`;
        const bytes = await this.loadParquetFileBytesAtPath(partPath);
        if (!bytes) {
          break;
        }
        partPaths.push(partPath);
      }
      return partPaths;
    })().then(
      (partPaths) => {
        if (partPaths.length === 0) {
          this.evictIfCurrent(this.parquetPartPathsCache, parquetPath, promise);
        }
        return partPaths;
      },
      (error) => {
        this.evictIfCurrent(this.parquetPartPathsCache, parquetPath, promise);
        throw error;
      }
    );
    this.parquetPartPathsCache.set(parquetPath, promise);
    return promise;
  }

  private async loadMultipartParquetTableFromPartPaths(
    parquetPath: string,
    partPaths: string[],
    columns: string[] | undefined,
    readParquet: ParquetModule['readParquet'],
    readSchema: ParquetModule['readSchema']
  ): Promise<ArrowTable> {
    const tables: ArrowTable[] = [];
    for (const partPath of partPaths) {
      const parquetBytes = await this.loadParquetFileBytesAtPath(partPath);
      if (!parquetBytes) {
        throw new Error(`Failed to load parquet part at ${partPath}.`);
      }
      tables.push(
        await this.readParquetTableFromFileBytes(
          parquetBytes,
          columns,
          readParquet,
          readSchema,
          parquetPath
        )
      );
    }
    if (tables.length === 0) {
      throw new Error(`Failed to load multipart parquet data from ${parquetPath}.`);
    }
    return tables.slice(1).reduce((merged, part) => merged.concat(part), tables[0]);
  }

  protected async readParquetDatasetBytes(parquetPath: string): Promise<Uint8Array[]> {
    const capped = await this.readParquetDatasetBytesCapped(parquetPath, Number.POSITIVE_INFINITY);
    return capped.parts;
  }

  /**
   * Read parquet part bytes up to a row cap. Uses dataset metadata to avoid
   * loading parts beyond the cap when row counts per part are known.
   */
  protected async readParquetDatasetBytesCapped(
    parquetPath: string,
    maxRows: number
  ): Promise<{ parts: Uint8Array[]; totalRows: number; truncated: boolean }> {
    const totalRows = await this.resolveParquetRowCount(parquetPath);
    if (totalRows <= maxRows) {
      const dataset = await this.loadParquetDatasetMetadata(parquetPath);
      if (dataset?.parts.length) {
        const parts: Uint8Array[] = [];
        for (const part of dataset.parts) {
          const bytes = await this.loadParquetFileBytesAtPath(part.path);
          if (!bytes) {
            // Strict fail — see docs/plans/parquet-io-error-handling.md
            throw new Error(`Missing parquet part bytes at ${part.path}`);
          }
          parts.push(bytes);
        }
        return { parts, totalRows, truncated: false };
      }
      const bytes = await this.loadParquetFileBytesAtPath(parquetPath);
      return { parts: bytes ? [bytes] : [], totalRows, truncated: false };
    }

    const dataset = await this.loadParquetDatasetMetadata(parquetPath);
    let partPaths: string[] = [];
    if (dataset?.parts.length) {
      partPaths = dataset.parts.map((part) => part.path);
    } else {
      const discovered = await this.discoverMultipartPartPaths(parquetPath);
      partPaths = discovered.length > 0 ? discovered : [parquetPath];
    }

    const numRowsByPart = dataset?.numRowsByPart ?? [];
    const parts: Uint8Array[] = [];
    let accumulated = 0;
    for (let partIndex = 0; partIndex < partPaths.length; partIndex += 1) {
      const remaining = maxRows - accumulated;
      if (remaining <= 0) {
        break;
      }
      const partPath = partPaths[partIndex];
      const bytes = await this.loadParquetFileBytesAtPath(partPath);
      if (!bytes) {
        // Strict fail (sibling capped table loader uses continue) — docs/plans/parquet-io-error-handling.md
        throw new Error(`Missing parquet bytes at ${partPath}`);
      }
      parts.push(bytes);
      const partRows = numRowsByPart[partIndex];
      if (typeof partRows === 'number' && Number.isFinite(partRows)) {
        accumulated += partRows;
      } else {
        accumulated = maxRows;
      }
      if (accumulated >= maxRows) {
        break;
      }
    }

    return { parts, totalRows, truncated: true };
  }

  async loadParquetTableCapped(
    parquetPath: string,
    columns: string[] | undefined,
    maxRows: number,
    options: { useRowGroupReads?: boolean } = {}
  ): Promise<{ table: ArrowTable; totalRows: number; truncated: boolean }> {
    const totalRows = await this.resolveParquetRowCount(parquetPath);
    const truncated = totalRows > maxRows;
    const targetRows = truncated ? maxRows : totalRows;

    if (options.useRowGroupReads === true && (await this.canLoadParquetRowGroups())) {
      try {
        const table = await this._loadParquetTableRowGroupsCapped(parquetPath, columns, targetRows);
        return { table, totalRows, truncated };
      } catch (error) {
        console.warn(
          `Row-group parquet read failed for ${parquetPath}; falling back to full-file decode.`,
          error
        );
      }
    }

    if (!truncated) {
      const table = await this.loadParquetTable(parquetPath, columns);
      return { table, totalRows, truncated: false };
    }
    const table = await this._loadParquetTableUncachedCapped(parquetPath, columns, maxRows);
    return { table, totalRows, truncated: true };
  }

  /**
   * Load up to {@link maxRows} via per-row-group range reads and optional column
   * projection. Avoids fetching entire parquet part files when the store supports
   * byte-range reads.
   */
  private async _loadParquetTableRowGroupsCapped(
    parquetPath: string,
    columns: string[] | undefined,
    maxRows: number
  ): Promise<ArrowTable> {
    const dataset = await this.loadParquetDatasetMetadata(parquetPath);
    if (!dataset || dataset.totalNumRowGroups <= 0) {
      throw new Error(`No row groups available for ${parquetPath}.`);
    }

    const { readSchema } = await SpatialDataTableSource.parquetModulePromise;
    const resolvedColumns = columns?.length
      ? await this.resolveParquetTableColumns(
          parquetPath,
          columns,
          readSchema,
          dataset.parts[0]?.schemaBytes
        )
      : undefined;
    const readOptions: ParquetRowGroupReadOptions | undefined = resolvedColumns?.length
      ? { columns: resolvedColumns }
      : undefined;

    const tables: ArrowTable[] = [];
    let accumulated = 0;
    for (let rowGroupIndex = 0; rowGroupIndex < dataset.totalNumRowGroups; rowGroupIndex += 1) {
      if (accumulated >= maxRows) {
        break;
      }
      let table = await this.loadParquetRowGroupByGroupIndex(
        parquetPath,
        rowGroupIndex,
        readOptions
      );
      if (!table || table.numRows === 0) {
        continue;
      }
      const remaining = maxRows - accumulated;
      if (table.numRows > remaining) {
        table = table.slice(0, remaining);
      }
      tables.push(table);
      accumulated += table.numRows;
    }

    if (tables.length === 0) {
      throw new Error(`Failed to load row-group capped parquet data from ${parquetPath}.`);
    }
    return tables.slice(1).reduce((merged, part) => merged.concat(part), tables[0]);
  }

  private async _loadParquetTableUncachedCapped(
    parquetPath: string,
    columns: string[] | undefined,
    maxRows: number
  ): Promise<ArrowTable> {
    const { readParquet, readSchema } = await SpatialDataTableSource.parquetModulePromise;

    const dataset = await this.loadParquetDatasetMetadata(parquetPath);
    let partPaths: string[] = [];
    if (dataset?.parts.length) {
      partPaths = dataset.parts.map((part) => part.path);
    } else {
      const discovered = await this.discoverMultipartPartPaths(parquetPath);
      partPaths = discovered.length > 0 ? discovered : [parquetPath];
    }

    const tables: ArrowTable[] = [];
    let accumulated = 0;
    for (let partIndex = 0; partIndex < partPaths.length; partIndex += 1) {
      const remaining = maxRows - accumulated;
      if (remaining <= 0) {
        break;
      }
      const partPath = partPaths[partIndex];
      const parquetBytes = await this.loadParquetFileBytesAtPath(partPath);
      if (!parquetBytes) {
        continue;
      }
      const partTable = await this.readParquetTableFromFileBytes(
        parquetBytes,
        columns,
        readParquet,
        readSchema,
        parquetPath
      );
      if (partTable.numRows <= remaining) {
        tables.push(partTable);
        accumulated += partTable.numRows;
      } else {
        tables.push(partTable.slice(0, remaining));
        break;
      }
    }

    if (tables.length === 0) {
      throw new Error(`Failed to load capped parquet data from ${parquetPath}.`);
    }
    return tables.slice(1).reduce((merged, part) => merged.concat(part), tables[0]);
  }

  protected async loadParquetFileBytesAtPath(path: string): Promise<Uint8Array | null> {
    try {
      const parquetBytes = await this.storeRoot.store.get(`/${path}`);
      const normalizedBytes = toUint8Array(parquetBytes);
      if (!normalizedBytes || !isParquetFileBytes(normalizedBytes)) {
        return null;
      }
      return normalizedBytes;
    } catch {
      return null;
    }
  }

  private async resolveParquetTableColumns(
    parquetPath: string,
    columns: string[] | undefined,
    readSchema: ParquetModule['readSchema'],
    schemaBytesFromPath?: Uint8Array | null
  ): Promise<string[] | undefined> {
    if (!columns?.length) {
      return undefined;
    }

    let indexColumnName: string | undefined;
    try {
      const schemaBytes = schemaBytesFromPath ?? (await this.loadParquetSchemaBytes(parquetPath));
      if (schemaBytes) {
        const wasmSchema = readSchema(schemaBytes);
        const arrowTableForSchema = await tableFromIPC(wasmSchema.intoIPCStream());
        indexColumnName = tableToIndexColumnName(arrowTableForSchema);
      }
    } catch (e: unknown) {
      //@ts-expect-error e.message not a property of e: unknown
      console.warn(`Failed to load parquet schema bytes for ${parquetPath}: ${e.message}`);
    }

    if (indexColumnName && !columns.includes(indexColumnName)) {
      return [...columns, indexColumnName];
    }
    return columns;
  }

  private async readParquetTableFromFileBytes(
    parquetBytes: Uint8Array,
    columns: string[] | undefined,
    readParquet: ParquetModule['readParquet'],
    readSchema: ParquetModule['readSchema'],
    parquetPath: string
  ): Promise<ArrowTable> {
    let normalizedBytes = parquetBytes;
    if (!ArrayBuffer.isView(normalizedBytes)) {
      normalizedBytes = new Uint8Array(normalizedBytes);
    }

    let resolvedColumns = columns;
    if (columns?.length) {
      resolvedColumns = await this.resolveParquetTableColumns(parquetPath, columns, readSchema);
      const wasmSchema = readSchema(normalizedBytes);
      const arrowTableForSchema = await tableFromIPC(wasmSchema.intoIPCStream());
      const indexColumnName = tableToIndexColumnName(arrowTableForSchema);
      if (indexColumnName && resolvedColumns && !resolvedColumns.includes(indexColumnName)) {
        resolvedColumns = [...resolvedColumns, indexColumnName];
      }
    }

    const wasmTable = readParquet(
      normalizedBytes,
      resolvedColumns?.length ? { columns: resolvedColumns } : undefined
    );
    return tableFromIPC(wasmTable.intoIPCStream());
  }

  private async loadMultipartParquetTable(
    parquetPath: string,
    columns: string[] | undefined,
    dataset: ParquetDatasetMetadata,
    readParquet: ParquetModule['readParquet'],
    readSchema: ParquetModule['readSchema']
  ): Promise<ArrowTable> {
    const resolvedColumns = columns?.length
      ? await this.resolveParquetTableColumns(
          parquetPath,
          columns,
          readSchema,
          dataset.parts[0]?.schemaBytes
        )
      : undefined;

    const tables: ArrowTable[] = [];
    for (const part of dataset.parts) {
      const parquetBytes = await this.loadParquetFileBytesAtPath(part.path);
      if (!parquetBytes) {
        throw new Error(`Failed to load parquet part at ${part.path}.`);
      }
      const wasmTable = readParquet(
        parquetBytes,
        resolvedColumns?.length ? { columns: resolvedColumns } : undefined
      );
      tables.push(await tableFromIPC(wasmTable.intoIPCStream()));
    }

    if (tables.length === 0) {
      throw new Error(`Failed to load multipart parquet data from ${parquetPath}.`);
    }
    return tables.slice(1).reduce((merged, part) => merged.concat(part), tables[0]);
  }

  private async _loadParquetTableUncached(
    parquetPath: string,
    columns?: string[]
  ): Promise<ArrowTable> {
    const { readParquet, readSchema } = await SpatialDataTableSource.parquetModulePromise;

    const dataset = await this.loadParquetDatasetMetadata(parquetPath);
    if (dataset && dataset.parts.length > 1) {
      return this.loadMultipartParquetTable(parquetPath, columns, dataset, readParquet, readSchema);
    }

    const partPaths = await this.discoverMultipartPartPaths(parquetPath);
    if (partPaths.length > 1) {
      return this.loadMultipartParquetTableFromPartPaths(
        parquetPath,
        partPaths,
        columns,
        readParquet,
        readSchema
      );
    }

    const parquetBytes = await this.loadParquetBytes(parquetPath);
    if (!parquetBytes) {
      throw new Error('Failed to load parquet data from store.');
    }
    return this.readParquetTableFromFileBytes(
      parquetBytes,
      columns,
      readParquet,
      readSchema,
      parquetPath
    );
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
