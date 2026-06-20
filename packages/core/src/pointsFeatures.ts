import { Type } from 'apache-arrow';
import type { Table, Vector } from 'apache-arrow';
import {
  isMortonSentinelValue,
  type PointsFeatureCatalog,
  type PointsFeatureEntry,
} from './pointsTiling.js';

function dictionaryStrings(column: Vector): string[] | null {
  if (column.type.typeId !== Type.Dictionary) {
    return null;
  }
  const dictionary = column.data[0]?.dictionary;
  if (!dictionary) {
    return null;
  }
  return dictionary.toArray().map((value: unknown) => (value == null ? '' : String(value)));
}

function resolveFeatureName(
  nameValue: unknown,
  dictionary: string[] | null
): string {
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
  const dictionary = dictionaryStrings(nameColumn);
  const codeToName = new Map<number, string>();
  const nameToCode = new Map<string, number>();

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

  const entries: PointsFeatureEntry[] = [...codeToName.entries()]
    .sort((left, right) => left[0] - right[0])
    .map(([code, name]) => ({ code, name }));

  return { featureKey, entries };
}

export function buildFeatureCatalogFromDictionaryOnly(
  featureKey: string,
  nameColumn: Vector,
  _codeColumn: Vector | null
): PointsFeatureCatalog | null {
  const dictionary = dictionaryStrings(nameColumn);
  if (!dictionary || dictionary.length === 0) {
    return null;
  }

  const entries: PointsFeatureEntry[] = dictionary.map((name, code) => ({ code, name }));
  return { featureKey, entries };
}

export function isDictionaryFeatureColumn(column: Vector): boolean {
  return column.type.typeId === Type.Dictionary;
}

function dictionaryIndexArray(column: Vector, numRows: number): Int32Array | null {
  if (!isDictionaryFeatureColumn(column)) {
    return null;
  }
  const out = new Int32Array(numRows);
  let offset = 0;
  for (const chunk of column.data) {
    const values = chunk.values;
    if (!values) {
      return null;
    }
    out.set(values, offset);
    offset += values.length;
  }
  return offset === numRows ? out : null;
}

/** Per-row integer codes for feature filtering (explicit codes column or dictionary indices). */
export function resolveRowFeatureCodesFromTable(
  table: Table,
  featureKey: string,
  featureCodeColumnName: string | undefined
): ArrayLike<number> | undefined {
  if (featureCodeColumnName) {
    return table.getChild(featureCodeColumnName)?.toArray();
  }
  const nameColumn = table.getChild(featureKey);
  if (!nameColumn || !isDictionaryFeatureColumn(nameColumn)) {
    return undefined;
  }
  const indices = dictionaryIndexArray(nameColumn, table.numRows);
  if (indices) {
    return indices;
  }
  const dictionary = dictionaryStrings(nameColumn);
  if (!dictionary) {
    return undefined;
  }
  const out = new Int32Array(table.numRows);
  for (let rowIndex = 0; rowIndex < table.numRows; rowIndex += 1) {
    const value = nameColumn.get(rowIndex);
    if (typeof value === 'number' && Number.isFinite(value)) {
      out[rowIndex] = value;
      continue;
    }
    const name = resolveFeatureName(value, dictionary);
    const code = dictionary.indexOf(name);
    out[rowIndex] = code >= 0 ? code : 0;
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
