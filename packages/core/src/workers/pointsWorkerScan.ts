import { tableFromIPC, type Table } from 'apache-arrow';
import {
  accumulateFeatureCatalogFromTable,
  buildFeatureCatalogFromColumns,
  countFeatureCodesHistogram,
  featureCatalogFromCodeMap,
  featureCatalogNeedsParquetFallback,
  featureCodeMapFromCatalog,
  resolveRowFeatureCodesFromTable,
} from '../pointsFeatures.js';
import type { PointsFeatureCatalog } from '../pointsTiling.js';
import {
  featureCodeAllowSet,
  isMortonSentinelValue,
  rowMatchesFeatureCode,
} from '../pointsTiling.js';

type ParquetWasmTableLike = { intoIPCStream(): Uint8Array };
type ParquetModule = {
  readParquet: (bytes: Uint8Array, options?: { columns?: string[] }) => ParquetWasmTableLike;
};

export type ParquetRowGroupBytesChunk = {
  schemaBytes: Uint8Array;
  rowGroupBytes: Uint8Array;
  rowGroupIndex: number;
  globalRowGroupIndex?: number;
};

type ReadParquetRowGroup = (
  schemaBytes: Uint8Array,
  rowGroupBytes: Uint8Array,
  rowGroupIndex: number,
  options?: { columns?: string[] }
) => ParquetWasmTableLike;

export async function decodeParquetPartsToTable(
  readParquet: ParquetModule['readParquet'],
  parts: Uint8Array[],
  columns: string[] | undefined,
  maxRows?: number
): Promise<Table> {
  const tables: Table[] = [];
  let accumulated = 0;
  for (const part of parts) {
    const table = tableFromIPC(readParquet(part, { columns }).intoIPCStream());
    if (maxRows === undefined) {
      tables.push(table);
      continue;
    }
    const remaining = maxRows - accumulated;
    if (table.numRows <= remaining) {
      tables.push(table);
      accumulated += table.numRows;
    } else {
      tables.push(table.slice(0, remaining));
      break;
    }
    if (accumulated >= maxRows) {
      break;
    }
  }
  if (tables.length === 0) {
    throw new Error('No parquet tables to decode');
  }
  return tables.slice(1).reduce((merged, part) => merged.concat(part), tables[0]);
}

export async function decodeParquetRowGroupsToTable(
  readParquetRowGroup: ReadParquetRowGroup,
  chunks: ParquetRowGroupBytesChunk[],
  columns: string[] | undefined,
  maxRows?: number
): Promise<Table> {
  const readOptions = columns?.length ? { columns } : undefined;
  const tables: Table[] = [];
  let accumulated = 0;
  for (const chunk of chunks) {
    const table = tableFromIPC(
      readParquetRowGroup(
        chunk.schemaBytes,
        chunk.rowGroupBytes,
        chunk.rowGroupIndex,
        readOptions
      ).intoIPCStream()
    );
    if (maxRows === undefined) {
      tables.push(table);
      continue;
    }
    const remaining = maxRows - accumulated;
    if (table.numRows <= remaining) {
      tables.push(table);
      accumulated += table.numRows;
    } else {
      tables.push(table.slice(0, remaining));
      break;
    }
    if (accumulated >= maxRows) {
      break;
    }
  }
  if (tables.length === 0) {
    throw new Error('No parquet row groups to decode');
  }
  return tables.slice(1).reduce((merged, part) => merged.concat(part), tables[0]);
}

export type ParquetWorkerPayloadInput = {
  parts?: Uint8Array[];
  rowGroups?: ParquetRowGroupBytesChunk[];
};

export async function decodeParquetPayloadToTable(
  readParquet: ParquetModule['readParquet'],
  readParquetRowGroup: ReadParquetRowGroup | undefined,
  payload: ParquetWorkerPayloadInput,
  columns: string[] | undefined,
  maxRows?: number
): Promise<Table> {
  if (payload.rowGroups?.length) {
    if (!readParquetRowGroup) {
      throw new Error('readParquetRowGroup is unavailable');
    }
    return decodeParquetRowGroupsToTable(
      readParquetRowGroup,
      payload.rowGroups,
      columns,
      maxRows
    );
  }
  if (payload.parts?.length) {
    return decodeParquetPartsToTable(readParquet, payload.parts, columns, maxRows);
  }
  throw new Error('No parquet parts or row groups to decode');
}

export function extractGeometryColumnar(
  table: Table,
  axisNames: string[]
): { shape: number[]; xs: Float32Array; ys: Float32Array; zs?: Float32Array } {
  const xColumn = table.getChild(axisNames[0]);
  const yColumn = table.getChild(axisNames[1]);
  if (!xColumn || !yColumn) {
    throw new Error(`Geometry columns not found in parquet table`);
  }
  const xs = Float32Array.from(xColumn.toArray() as ArrayLike<number>);
  const ys = Float32Array.from(yColumn.toArray() as ArrayLike<number>);
  const hasZ = axisNames.includes('z');
  const zColumn = hasZ ? table.getChild('z') : null;
  const zs = zColumn ? Float32Array.from(zColumn.toArray() as ArrayLike<number>) : undefined;
  const shape = zs ? [3, xs.length] : [2, xs.length];
  return { shape, xs, ys, ...(zs ? { zs } : {}) };
}

export type DecodeGeometryWithFeaturesInput = ParquetWorkerPayloadInput & {
  axisNames: string[];
  /** Projected columns to decode: axes + feature key (+ code column if present). */
  columns: string[];
  featureKey: string;
  featureCodeColumnName?: string;
  maxRows?: number;
};

export type DecodeGeometryWithFeaturesResult = {
  shape: number[];
  data: Float32Array[];
  featureCodes?: Int32Array;
  featureCatalog?: PointsFeatureCatalog;
};

/**
 * One projected decode → geometry + per-row feature codes + feature catalog.
 *
 * This is the off-thread half of the codes-with-geometry preload: the caller
 * fetches whole row-group (or part) bytes via async range reads and hands them
 * here (in the worker) so the CPU-heavy parquet decode never touches the main
 * thread. Column projection still runs during decode, but the *bytes* are whole
 * row groups (all columns) — parquet-wasm cannot fetch individual column chunks
 * (see docs/parquet-wasm-limitations.md). Mirrors the main-thread derivation in
 * `VPointsSource.loadPoints` so both paths produce identical codes + catalog.
 */
export async function decodeGeometryWithFeaturesFromPayload(
  readParquet: ParquetModule['readParquet'],
  readParquetRowGroup: ReadParquetRowGroup | undefined,
  input: DecodeGeometryWithFeaturesInput
): Promise<DecodeGeometryWithFeaturesResult> {
  const table = await decodeParquetPayloadToTable(
    readParquet,
    readParquetRowGroup,
    { rowGroups: input.rowGroups, parts: input.parts },
    input.columns,
    input.maxRows
  );

  const geometry = extractGeometryColumnar(table, input.axisNames);
  const data = geometry.zs ? [geometry.xs, geometry.ys, geometry.zs] : [geometry.xs, geometry.ys];

  let featureCodes: Int32Array | undefined;
  let featureCatalog: PointsFeatureCatalog | undefined;
  const nameColumn = table.getChild(input.featureKey);
  if (nameColumn) {
    const codeColumn = input.featureCodeColumnName
      ? table.getChild(input.featureCodeColumnName)
      : null;
    featureCatalog = buildFeatureCatalogFromColumns(
      input.featureKey,
      nameColumn,
      codeColumn ?? null,
      null,
      table.numRows
    );
    const featureCodeByName = input.featureCodeColumnName
      ? undefined
      : featureCodeMapFromCatalog(featureCatalog);
    const codes = resolveRowFeatureCodesFromTable(
      table,
      input.featureKey,
      input.featureCodeColumnName,
      featureCodeByName
    );
    if (codes) {
      featureCodes = codes instanceof Int32Array ? codes : Int32Array.from(codes);
    }
  }

  return {
    shape: geometry.shape,
    data,
    ...(featureCodes ? { featureCodes } : {}),
    ...(featureCatalog ? { featureCatalog } : {}),
  };
}

export async function scanFeatureCatalogFromPayload(
  readParquet: ParquetModule['readParquet'],
  readParquetRowGroup: ReadParquetRowGroup | undefined,
  input: {
    rowGroups?: ParquetRowGroupBytesChunk[];
    parts: Uint8Array[];
    columns: string[];
    featureKey: string;
    featureCodeColumnName?: string;
    skipMortonSentinels?: boolean;
  }
): Promise<PointsFeatureCatalog | null> {
  const codeToName = new Map<number, string>();
  const nameToCode = new Map<string, number>();
  const catalogOptions = { skipMortonSentinels: input.skipMortonSentinels === true };

  if (input.featureCodeColumnName && input.rowGroups?.length && readParquetRowGroup) {
    const readOptions = { columns: input.columns };
    for (const chunk of input.rowGroups) {
      const table = tableFromIPC(
        readParquetRowGroup(
          chunk.schemaBytes,
          chunk.rowGroupBytes,
          chunk.rowGroupIndex,
          readOptions
        ).intoIPCStream()
      );
      if (table.numRows === 0) {
        continue;
      }
      accumulateFeatureCatalogFromTable(
        codeToName,
        nameToCode,
        table,
        input.featureKey,
        input.featureCodeColumnName,
        catalogOptions
      );
    }
  }

  if (featureCatalogNeedsParquetFallback(codeToName)) {
    codeToName.clear();
    nameToCode.clear();
    const table = await decodeParquetPartsToTable(readParquet, input.parts, input.columns);
    accumulateFeatureCatalogFromTable(
      codeToName,
      nameToCode,
      table,
      input.featureKey,
      input.featureCodeColumnName,
      catalogOptions
    );
  }

  if (codeToName.size === 0) {
    return null;
  }
  return featureCatalogFromCodeMap(input.featureKey, codeToName);
}

export function scanMortonTableInBounds(input: {
  table: Table;
  rowGroupIndex: number;
  bounds: { minX: number; maxX: number; minY: number; maxY: number };
  axisNames: string[];
  mortonCodeColumnName: string;
  featureCodeColumnName?: string;
  featureCodes?: readonly number[];
  xs: number[];
  ys: number[];
  zs: number[];
}): void {
  const allowedFeatureCodes = featureCodeAllowSet(input.featureCodes);
  const filterByFeature = allowedFeatureCodes !== null;
  const hasZ = input.axisNames.includes('z');
  const xColumn = input.table.getChild('x');
  const yColumn = input.table.getChild('y');
  const zColumn = hasZ ? input.table.getChild('z') : null;
  const mortonColumn = input.table.getChild(input.mortonCodeColumnName);
  const featureCodeColumn = input.featureCodeColumnName
    ? input.table.getChild(input.featureCodeColumnName)
    : null;
  if (!xColumn || !yColumn) {
    return;
  }
  for (let rowIndex = 0; rowIndex < input.table.numRows; rowIndex += 1) {
    if (
      input.rowGroupIndex === 0 &&
      rowIndex < 4 &&
      isMortonSentinelValue(mortonColumn?.get(rowIndex))
    ) {
      continue;
    }
    if (
      filterByFeature &&
      featureCodeColumn &&
      !rowMatchesFeatureCode(featureCodeColumn.get(rowIndex), allowedFeatureCodes)
    ) {
      continue;
    }
    const x = xColumn.get(rowIndex);
    const y = yColumn.get(rowIndex);
    if (typeof x !== 'number' || typeof y !== 'number') {
      continue;
    }
    if (
      x < input.bounds.minX ||
      x > input.bounds.maxX ||
      y < input.bounds.minY ||
      y > input.bounds.maxY
    ) {
      continue;
    }
    input.xs.push(x);
    input.ys.push(y);
    if (zColumn) {
      const z = zColumn.get(rowIndex);
      input.zs.push(typeof z === 'number' ? z : 0);
    }
  }
}

export function extractRowFeatureCodesFromTable(
  table: Table,
  featureKey: string,
  featureCodeColumnName?: string,
  featureCodeByName?: ReadonlyMap<string, number>
): Int32Array {
  const resolved = resolveRowFeatureCodesFromTable(
    table,
    featureKey,
    featureCodeColumnName,
    featureCodeByName
  );
  if (!resolved) {
    return new Int32Array(0);
  }
  if (resolved instanceof Int32Array) {
    return resolved;
  }
  return Int32Array.from(resolved);
}

export function histogramToSortedArrays(counts: Map<number, number>): {
  codes: Int32Array;
  countValues: Uint32Array;
} {
  const sorted = [...counts.entries()].sort((left, right) => left[0] - right[0]);
  return {
    codes: Int32Array.from(sorted.map(([code]) => code)),
    countValues: Uint32Array.from(sorted.map(([, count]) => count)),
  };
}

export function scanTableFeatureCounts(
  table: Table,
  featureKey: string,
  featureCodeColumnName: string | undefined,
  counts: Map<number, number>
): void {
  const rowCodes = extractRowFeatureCodesFromTable(table, featureKey, featureCodeColumnName);
  for (let index = 0; index < rowCodes.length; index += 1) {
    const code = rowCodes[index];
    counts.set(code, (counts.get(code) ?? 0) + 1);
  }
}

export function scanTableByFeatureCodes(input: {
  table: Table;
  axisNames: string[];
  featureKey: string;
  featureCodeColumnName?: string;
  featureCodes: readonly number[];
  memoryCap: number;
  matchedRows: number;
  xs: number[];
  ys: number[];
  zs: number[];
}): number {
  const allowed = featureCodeAllowSet(input.featureCodes);
  if (allowed !== null && allowed.size === 0) {
    return input.matchedRows;
  }
  const rowCodes = extractRowFeatureCodesFromTable(
    input.table,
    input.featureKey,
    input.featureCodeColumnName
  );
  const xColumn = input.axisNames.includes('x') ? input.table.getChild('x') : null;
  const yColumn = input.axisNames.includes('y') ? input.table.getChild('y') : null;
  const zColumn = input.axisNames.includes('z') ? input.table.getChild('z') : null;
  if (!xColumn || !yColumn) {
    return input.matchedRows;
  }
  let matchedRows = input.matchedRows;
  for (let rowIndex = 0; rowIndex < input.table.numRows; rowIndex += 1) {
    if (matchedRows >= input.memoryCap) {
      break;
    }
    if (allowed !== null && !rowMatchesFeatureCode(rowCodes[rowIndex], allowed)) {
      continue;
    }
    const x = xColumn.get(rowIndex);
    const y = yColumn.get(rowIndex);
    if (typeof x !== 'number' || typeof y !== 'number') {
      continue;
    }
    input.xs.push(x);
    input.ys.push(y);
    if (zColumn) {
      const z = zColumn.get(rowIndex);
      input.zs.push(typeof z === 'number' ? z : 0);
    }
    matchedRows += 1;
  }
  return matchedRows;
}

export function countFeatureCodesFromArray(sourceFeatureCodes: ArrayLike<number>): {
  codes: Int32Array;
  countValues: Uint32Array;
} {
  return histogramToSortedArrays(countFeatureCodesHistogram(sourceFeatureCodes));
}
