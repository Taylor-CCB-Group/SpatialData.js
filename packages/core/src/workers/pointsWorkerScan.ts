import { tableFromIPC, type Table } from 'apache-arrow';
import {
  countFeatureCodesHistogram,
  resolveRowFeatureCodesFromTable,
} from '../pointsFeatures.js';
import {
  featureCodeAllowSet,
  rowMatchesFeatureCode,
} from '../pointsTiling.js';

type ParquetWasmTableLike = { intoIPCStream(): Uint8Array };
type ParquetModule = {
  readParquet: (bytes: Uint8Array, options?: { columns?: string[] }) => ParquetWasmTableLike;
};

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

export function extractRowFeatureCodesFromTable(
  table: Table,
  featureKey: string,
  featureCodeColumnName?: string
): Int32Array {
  const resolved = resolveRowFeatureCodesFromTable(table, featureKey, featureCodeColumnName);
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
