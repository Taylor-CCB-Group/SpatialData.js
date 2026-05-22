import type { ElementName, TableColumnData } from './types';
import type { SpatialData } from './store';

type SpatialAssociationKind = Exclude<ElementName, 'tables'>;

export interface AssociatedTableFeatureRows {
  rowIds?: string[];
  rowIndexByFeatureId?: Map<string, number>;
  regionColumn?: TableColumnData | undefined;
  extraColumns?: Array<TableColumnData | undefined>;
}

function createDefaultRowIndexByFeatureIndex(length: number): Int32Array {
  const indices = new Int32Array(length);
  indices.fill(-1);
  return indices;
}

function normalizeCellValue(value: TableColumnData | undefined, rowIndex: number): string {
  if (value === undefined) return '';
  const row = value[rowIndex];
  if (row === null || row === undefined) return '';
  return String(row);
}

function buildAcceptedRegionValues(
  kind: SpatialAssociationKind,
  key: string,
  tableRegions: string[]
): Set<string> {
  const accepted = new Set<string>([key, `${kind}/${key}`]);
  for (const regionName of tableRegions) {
    accepted.add(regionName);
    accepted.add(`${kind}/${regionName}`);
  }
  return accepted;
}

export function isSpatialData(value: unknown): value is SpatialData {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as SpatialData).getAssociatedTable === 'function'
  );
}

export async function loadAssociatedTableFeatureRows({
  spatialData,
  kind,
  key,
  extraColumnNames = [],
}: {
  spatialData: SpatialData | undefined;
  kind: SpatialAssociationKind;
  key: string;
  extraColumnNames?: string[];
}): Promise<AssociatedTableFeatureRows> {
  if (!spatialData) {
    return {
      rowIds: undefined,
      rowIndexByFeatureId: undefined,
      regionColumn: undefined,
      extraColumns: undefined,
    };
  }

  const associated = spatialData.getAssociatedTable(kind, key);
  if (!associated) {
    return {
      rowIds: undefined,
      rowIndexByFeatureId: undefined,
      regionColumn: undefined,
      extraColumns: undefined,
    };
  }

  const [, table] = associated;
  const { region: tableRegions, regionKey } = table.getTableKeys();
  const acceptedRegionValues = buildAcceptedRegionValues(kind, key, tableRegions);
  const seenExtra = new Set<string>();
  const uniqueExtra = extraColumnNames.filter((name) => {
    if (name === regionKey || seenExtra.has(name)) {
      return false;
    }
    seenExtra.add(name);
    return true;
  });
  const requestedColumns = [regionKey, ...uniqueExtra];
  const rowIds = await table.loadObsIndex();
  const columns = await table.loadObsColumns(requestedColumns);
  const regionColumn = columns[0];
  const extraColumns = columns.slice(1);
  const filteredRowIds: string[] = [];
  const rowIndexByFeatureId = new Map<string, number>();

  for (let rowIndex = 0; rowIndex < rowIds.length; rowIndex++) {
    const regionValue = normalizeCellValue(regionColumn, rowIndex);
    if (regionValue && !acceptedRegionValues.has(regionValue)) {
      continue;
    }
    const rowId = String(rowIds[rowIndex]);
    filteredRowIds.push(rowId);
    rowIndexByFeatureId.set(rowId, rowIndex);
  }

  // Shared tables (e.g. Xenium cell_circles + cells) may tag every row with a
  // sibling region such as "cells" while still annotating this shapes element.
  if (rowIndexByFeatureId.size === 0 && rowIds.length > 0) {
    for (let rowIndex = 0; rowIndex < rowIds.length; rowIndex++) {
      const rowId = String(rowIds[rowIndex]);
      filteredRowIds.push(rowId);
      rowIndexByFeatureId.set(rowId, rowIndex);
    }
  }

  return {
    rowIds: filteredRowIds,
    rowIndexByFeatureId,
    regionColumn,
    extraColumns,
  };
}

export async function loadFeatureRowIndexByFeatureIndex({
  spatialData,
  kind,
  key,
  featureIds,
}: {
  spatialData: SpatialData | undefined;
  kind: SpatialAssociationKind;
  key: string;
  featureIds: string[];
}): Promise<Int32Array> {
  const rowIndexByFeatureIndex = createDefaultRowIndexByFeatureIndex(featureIds.length);
  if (featureIds.length === 0) {
    return rowIndexByFeatureIndex;
  }

  // Note for future optimization work:
  // this helper is intended to be general-purpose and correct first. If we end up
  // calling it on hot interactive paths for large tables, we should evaluate
  // pushing the matching work into workers and/or caching reusable mappings.
  const associatedRows = await loadAssociatedTableFeatureRows({
    spatialData,
    kind,
    key,
  });

  if (!associatedRows.rowIndexByFeatureId) {
    return rowIndexByFeatureIndex;
  }

  for (const [featureIndex, featureId] of featureIds.entries()) {
    const matchedRowIndex = associatedRows.rowIndexByFeatureId.get(featureId);
    if (matchedRowIndex !== undefined) {
      rowIndexByFeatureIndex[featureIndex] = matchedRowIndex;
    }
  }

  return rowIndexByFeatureIndex;
}
