import type { Table, Vector } from 'apache-arrow';
import { Type } from 'apache-arrow';
import {
  isMortonSentinelValue,
  MORTON_CODE_2D_COLUMN,
  type PointsFeatureCatalog,
  type PointsFeatureEntry,
} from './pointsTiling.js';

function dictionaryStrings(column: Vector): string[] | null {
  if (column.type.typeId !== Type.Dictionary) {
    return null;
  }
  for (const chunk of column.data) {
    const dictionary = chunk.dictionary;
    if (dictionary && dictionary.length > 0) {
      return dictionary.toArray().map((value: unknown) => (value == null ? '' : String(value)));
    }
  }
  return null;
}

function resolveFeatureName(nameValue: unknown, dictionary: string[] | null): string {
  if (nameValue == null) {
    return '';
  }
  if (dictionary && typeof nameValue === 'number' && Number.isFinite(nameValue)) {
    return dictionary[nameValue] ?? '';
  }
  return String(nameValue);
}

export function buildFeatureCatalogFromColumns(
  featureKey: string,
  nameColumn: Vector,
  codeColumn: Vector | null,
  mortonColumn: Vector | null,
  numRows: number
): PointsFeatureCatalog {
  const codeToName = new Map<number, string>();
  const nameToCode = new Map<string, number>();
  accumulateFeatureCatalogFromVectors(
    codeToName,
    nameToCode,
    nameColumn,
    codeColumn,
    mortonColumn,
    numRows
  );
  return featureCatalogFromCodeMap(featureKey, codeToName);
}

export function accumulateFeatureCatalogFromTable(
  codeToName: Map<number, string>,
  nameToCode: Map<string, number>,
  table: Table,
  featureKey: string,
  featureCodeColumnName: string | undefined,
  options: { skipMortonSentinels?: boolean } = {}
): void {
  const nameColumn = table.getChild(featureKey);
  if (!nameColumn) {
    return;
  }
  const codeColumn = featureCodeColumnName ? table.getChild(featureCodeColumnName) : null;
  const mortonColumn =
    options.skipMortonSentinels === true ? table.getChild(MORTON_CODE_2D_COLUMN) : null;
  accumulateFeatureCatalogFromVectors(
    codeToName,
    nameToCode,
    nameColumn,
    codeColumn,
    mortonColumn,
    table.numRows
  );
}

export function featureCatalogFromCodeMap(
  featureKey: string,
  codeToName: Map<number, string>
): PointsFeatureCatalog {
  const entries: PointsFeatureEntry[] = [...codeToName.entries()]
    .sort((left, right) => left[0] - right[0])
    .map(([code, name]) => ({ code, name }));
  return { featureKey, entries };
}

/** Row-group reads can yield empty names for dictionary-only columns; prefer readParquet. */
export function featureCatalogNeedsParquetFallback(codeToName: Map<number, string>): boolean {
  if (codeToName.size === 0) {
    return true;
  }
  return [...codeToName.values()].every((name) => name.length === 0);
}

export function featureCodeMapFromCatalog(
  catalog: PointsFeatureCatalog | null | undefined
): Map<string, number> | undefined {
  if (!catalog) {
    return undefined;
  }
  return new Map(catalog.entries.map((entry) => [entry.name, entry.code]));
}

/**
 * Translate per-row feature codes from one catalog's code space into another,
 * matching by feature name (`fromCode → name → toCode`). Rows whose code has no
 * name in `fromCatalog`, or whose name is absent from `toCatalog`, become `-1`.
 *
 * For dictionary-only feature columns there is no file-backed code: each catalog
 * build assigns codes by first-seen order, so the resident-preview catalog and
 * the full-dataset catalog can give the same gene different codes. Re-deriving
 * row codes against the authoritative (full) catalog with this helper keeps the
 * render's per-row codes in the same space as the panel's selection and swatches.
 * When both catalogs already agree (a real code column), every code maps to
 * itself — a harmless identity pass.
 */
export function remapRowFeatureCodes(
  rowCodes: ArrayLike<number>,
  fromCatalog: PointsFeatureCatalog,
  toCatalog: PointsFeatureCatalog
): Int32Array {
  const fromCodeToName = new Map<number, string>(
    fromCatalog.entries.map((entry) => [entry.code, entry.name])
  );
  const toNameToCode = new Map<string, number>(
    toCatalog.entries.map((entry) => [entry.name, entry.code])
  );
  // Translation is per distinct source code (a few hundred–thousand features),
  // not per row: build the small code→code map once, then map the rows.
  const codeRemap = new Map<number, number>();
  for (const [fromCode, name] of fromCodeToName) {
    codeRemap.set(fromCode, toNameToCode.get(name) ?? -1);
  }
  const out = new Int32Array(rowCodes.length);
  for (let index = 0; index < rowCodes.length; index += 1) {
    out[index] = codeRemap.get(rowCodes[index]) ?? -1;
  }
  return out;
}

function accumulateFeatureCatalogFromVectors(
  codeToName: Map<number, string>,
  nameToCode: Map<string, number>,
  nameColumn: Vector,
  codeColumn: Vector | null,
  mortonColumn: Vector | null,
  numRows: number
): void {
  const dictionary = dictionaryStrings(nameColumn);

  for (let rowIndex = 0; rowIndex < numRows; rowIndex += 1) {
    if (mortonColumn && rowIndex < 4 && isMortonSentinelValue(mortonColumn.get(rowIndex))) {
      continue;
    }
    const name = resolveFeatureName(nameColumn.get(rowIndex), dictionary);
    if (codeColumn) {
      const codeValue = codeColumn.get(rowIndex);
      const code = typeof codeValue === 'number' ? codeValue : Number(codeValue);
      if (!Number.isFinite(code)) {
        continue;
      }
      if (!codeToName.has(code)) {
        codeToName.set(code, name);
      }
      continue;
    }
    if (!nameToCode.has(name)) {
      nameToCode.set(name, nameToCode.size);
    }
    const code = nameToCode.get(name);
    if (code !== undefined && !codeToName.has(code)) {
      codeToName.set(code, name);
    }
  }
}

export function mergeDictionaryFeatureCatalogEntries(
  codeToName: Map<number, string>,
  nameColumn: Vector
): boolean {
  const dictionary = dictionaryStrings(nameColumn);
  if (dictionary && dictionary.length > 0) {
    for (let code = 0; code < dictionary.length; code += 1) {
      if (!codeToName.has(code)) {
        codeToName.set(code, dictionary[code] ?? '');
      }
    }
    return true;
  }

  const numRows = nameColumn.length;
  if (numRows <= 0) {
    return false;
  }
  let added = false;
  for (let row = 0; row < numRows; row += 1) {
    const code = getDictionaryIndexAt(nameColumn, row);
    if (code === null || !Number.isFinite(code) || codeToName.has(code)) {
      continue;
    }
    const decoded = nameColumn.get(row);
    const name = decoded == null ? '' : String(decoded);
    if (name.length > 0) {
      codeToName.set(code, name);
      added = true;
    }
  }
  return added;
}

export function buildFeatureCatalogFromDictionaryOnly(
  featureKey: string,
  nameColumn: Vector,
  _codeColumn: Vector | null
): PointsFeatureCatalog | null {
  const codeToName = new Map<number, string>();
  if (!mergeDictionaryFeatureCatalogEntries(codeToName, nameColumn)) {
    return null;
  }
  if (codeToName.size === 0) {
    return null;
  }
  return featureCatalogFromCodeMap(featureKey, codeToName);
}

export function isDictionaryFeatureColumn(column: Vector): boolean {
  return column.type.typeId === Type.Dictionary;
}

function getDictionaryIndexAt(column: Vector, row: number): number | null {
  if (!isDictionaryFeatureColumn(column) || row < 0 || row >= column.length) {
    return null;
  }
  let currentRow = 0;
  for (const chunk of column.data) {
    const values = chunk.values;
    if (!values) {
      continue;
    }
    const chunkLength = chunk.length ?? values.length;
    if (row < currentRow + chunkLength) {
      const valueIndex = (chunk.offset ?? 0) + (row - currentRow);
      if (valueIndex < 0 || valueIndex >= values.length) {
        return null;
      }
      const index = values[valueIndex];
      if (typeof index === 'number' && Number.isFinite(index)) {
        return index;
      }
      if (typeof index === 'bigint') {
        return Number(index);
      }
      const asNumber = Number(index);
      return Number.isFinite(asNumber) ? asNumber : null;
    }
    currentRow += chunkLength;
  }
  return null;
}

function _dictionaryIndexArray(column: Vector, numRows: number): Int32Array | null {
  if (!isDictionaryFeatureColumn(column)) {
    return null;
  }
  const rowCount = Math.min(numRows, column.length);
  if (rowCount <= 0) {
    return null;
  }
  const out = new Int32Array(rowCount);
  for (let row = 0; row < rowCount; row += 1) {
    const index = getDictionaryIndexAt(column, row);
    out[row] = index !== null && Number.isFinite(index) ? index : 0;
  }
  return out;
}

/** Per-row integer codes for feature filtering (explicit codes column or dictionary indices). */
export function resolveRowFeatureCodesFromTable(
  table: Table,
  featureKey: string,
  featureCodeColumnName: string | undefined,
  featureCodeByName?: ReadonlyMap<string, number>
): ArrayLike<number> | undefined {
  const nameColumn = table.getChild(featureKey);
  if (featureCodeColumnName) {
    return table.getChild(featureCodeColumnName)?.toArray();
  }
  if (!nameColumn) {
    return undefined;
  }
  const dictionary = dictionaryStrings(nameColumn);

  if (!featureCodeByName) {
    return undefined;
  }

  const out = new Int32Array(table.numRows);
  for (let rowIndex = 0; rowIndex < table.numRows; rowIndex += 1) {
    const name = resolveFeatureName(nameColumn.get(rowIndex), dictionary);
    out[rowIndex] = featureCodeByName.get(name) ?? -1;
  }
  return out;
}

export function featureFilterNeedsRowCodes(
  featureCodes: readonly number[] | undefined,
  featureCodeColumnName: string | undefined,
  featureKey: string,
  fields: string[]
): boolean {
  if (featureCodes === undefined) {
    return false;
  }
  if (featureCodeColumnName) {
    return true;
  }
  return fields.includes(featureKey);
}

/** Histogram of integer feature codes (single pass, worker-safe). */
export function countFeatureCodesHistogram(
  sourceFeatureCodes: ArrayLike<number>
): Map<number, number> {
  const counts = new Map<number, number>();
  for (let index = 0; index < sourceFeatureCodes.length; index += 1) {
    const code = sourceFeatureCodes[index];
    if (typeof code !== 'number' || !Number.isFinite(code)) {
      continue;
    }
    counts.set(code, (counts.get(code) ?? 0) + 1);
  }
  return counts;
}

export function mergeFeatureCountsIntoCatalog(
  catalog: PointsFeatureCatalog,
  counts: ReadonlyMap<number, number>
): PointsFeatureCatalog {
  return {
    ...catalog,
    entries: catalog.entries.map((entry) => ({
      ...entry,
      count: counts.get(entry.code) ?? entry.count,
    })),
  };
}
