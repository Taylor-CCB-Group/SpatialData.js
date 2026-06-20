import { Type } from 'apache-arrow';
import type { Vector } from 'apache-arrow';
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
  codeColumn: Vector | null
): PointsFeatureCatalog | null {
  const dictionary = dictionaryStrings(nameColumn);
  if (!dictionary || dictionary.length === 0) {
    return null;
  }

  if (codeColumn) {
    const codeToName = new Map<number, string>();
    for (let rowIndex = 0; rowIndex < codeColumn.length; rowIndex += 1) {
      const codeValue = codeColumn.get(rowIndex);
      const code = typeof codeValue === 'number' ? codeValue : Number(codeValue);
      if (!Number.isFinite(code) || codeToName.has(code)) {
        continue;
      }
      const nameIndex = nameColumn.get(rowIndex);
      const name = resolveFeatureName(nameIndex, dictionary);
      codeToName.set(code, name);
    }
    const entries: PointsFeatureEntry[] = [...codeToName.entries()]
      .sort((left, right) => left[0] - right[0])
      .map(([code, name]) => ({ code, name }));
    return { featureKey, entries };
  }

  const entries: PointsFeatureEntry[] = dictionary.map((name, code) => ({ code, name }));
  return { featureKey, entries };
}

export function isDictionaryFeatureColumn(column: Vector): boolean {
  return column.type.typeId === Type.Dictionary;
}
