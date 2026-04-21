import type { LabelsElement, ShapesElement } from './models';
import type { SpatialData } from './store';
import type { TableColumnData } from './types';

export type SpatialFeatureTooltipItem = {
  label: string;
  value: string;
};

export type SpatialFeatureTooltipData = {
  title?: string;
  items: SpatialFeatureTooltipItem[];
};

interface BaseTooltipMetadata {
  tooltipSignature?: string;
  tooltipFields?: string[];
  tooltipColumns?: Array<TableColumnData | undefined>;
}

export interface ShapesTooltipMetadata extends BaseTooltipMetadata {
  featureIds?: string[];
  tooltipRowIndices?: Int32Array;
}

export interface LabelsTooltipMetadata extends BaseTooltipMetadata {
  tooltipRowIndexByFeatureId?: Map<string, number>;
}

interface AssociatedTableTooltipData extends BaseTooltipMetadata {
  rowIds?: string[];
  rowIndexByFeatureId?: Map<string, number>;
}

export function getTooltipSignature(tooltipFields?: string[]): string {
  return (tooltipFields ?? []).join('\u0001');
}

export function normalizeTooltipValue(
  value: TableColumnData | undefined,
  rowIndex: number
): string {
  if (!value) return '';
  const row = value[rowIndex];
  if (row === null || row === undefined) return '';
  return String(row);
}

export function resolveTooltipItems(
  tooltipFields: string[] | undefined,
  tooltipColumns: Array<TableColumnData | undefined> | undefined,
  rowIndex: number
): SpatialFeatureTooltipItem[] {
  if (!tooltipFields || !tooltipColumns || rowIndex < 0) {
    return [];
  }
  return tooltipFields
    .map((field, fieldIndex) => ({
      label: field,
      value: normalizeTooltipValue(tooltipColumns[fieldIndex], rowIndex),
    }))
    .filter((item) => item.value !== '');
}

function tableRegionMatches(kind: 'shapes' | 'labels', regionValue: string, key: string) {
  return regionValue === key || regionValue === `${kind}/${key}`;
}

async function loadAssociatedTableTooltipData({
  spatialData,
  kind,
  key,
  tooltipFields,
}: {
  spatialData: SpatialData | undefined;
  kind: 'shapes' | 'labels';
  key: string;
  tooltipFields: string[];
}): Promise<AssociatedTableTooltipData> {
  if (tooltipFields.length === 0) {
    return {
      tooltipSignature: '',
      tooltipFields: [],
      tooltipColumns: undefined,
      rowIds: undefined,
      rowIndexByFeatureId: undefined,
    };
  }

  if (!spatialData) {
    return {
      tooltipSignature: undefined,
      tooltipFields,
      tooltipColumns: undefined,
      rowIds: undefined,
      rowIndexByFeatureId: undefined,
    };
  }

  const associated = spatialData.getAssociatedTable(kind, key);
  if (!associated) {
    return {
      tooltipSignature: undefined,
      tooltipFields,
      tooltipColumns: undefined,
      rowIds: undefined,
      rowIndexByFeatureId: undefined,
    };
  }

  const tooltipSignature = getTooltipSignature(tooltipFields);
  const [, table] = associated;
  const { regionKey } = table.getTableKeys();
  const requestedColumns = Array.from(new Set([regionKey, ...tooltipFields]));
  const rowIds = await table.loadObsIndex();
  const columns = await table.loadObsColumns(requestedColumns);
  const regionColumn = columns[0];
  const tooltipColumns = columns.slice(1);
  const filteredRowIds: string[] = [];
  const rowIndexByFeatureId = new Map<string, number>();

  for (let rowIndex = 0; rowIndex < rowIds.length; rowIndex++) {
    const regionValue = normalizeTooltipValue(regionColumn, rowIndex);
    if (regionValue && !tableRegionMatches(kind, regionValue, key)) {
      continue;
    }
    const rowId = String(rowIds[rowIndex]);
    filteredRowIds.push(rowId);
    rowIndexByFeatureId.set(rowId, rowIndex);
  }

  return {
    tooltipSignature,
    tooltipFields,
    tooltipColumns,
    rowIds: filteredRowIds,
    rowIndexByFeatureId,
  };
}

export async function loadShapesTooltipMetadata(
  spatialData: SpatialData | undefined,
  element: ShapesElement,
  tooltipFields: string[]
): Promise<ShapesTooltipMetadata> {
  const featureIdsRaw = await element.loadFeatureIds();
  const featureIds = featureIdsRaw
    ? Array.from(featureIdsRaw, (value: unknown) => String(value))
    : undefined;

  const associated = await loadAssociatedTableTooltipData({
    spatialData,
    kind: 'shapes',
    key: element.key,
    tooltipFields,
  });

  let tooltipRowIndices: Int32Array | undefined;
  if (featureIds && associated.rowIds && associated.rowIndexByFeatureId) {
    const isDirectlyAligned =
      associated.rowIds.length === featureIds.length &&
      associated.rowIds.every((rowId, index) => rowId === featureIds[index]);

    if (!isDirectlyAligned) {
      tooltipRowIndices = new Int32Array(featureIds.length);
      tooltipRowIndices.fill(-1);
      for (const [featureIndex, featureId] of featureIds.entries()) {
        const matchedRowIndex = associated.rowIndexByFeatureId.get(featureId);
        if (matchedRowIndex !== undefined) {
          tooltipRowIndices[featureIndex] = matchedRowIndex;
        }
      }
    }
  }

  return {
    featureIds,
    tooltipSignature: associated.tooltipSignature,
    tooltipFields: associated.tooltipFields,
    tooltipColumns: associated.tooltipColumns,
    tooltipRowIndices,
  };
}

export async function loadLabelsTooltipMetadata(
  spatialData: SpatialData | undefined,
  element: LabelsElement,
  tooltipFields: string[]
): Promise<LabelsTooltipMetadata> {
  const associated = await loadAssociatedTableTooltipData({
    spatialData,
    kind: 'labels',
    key: element.key,
    tooltipFields,
  });

  return {
    tooltipSignature: associated.tooltipSignature,
    tooltipFields: associated.tooltipFields,
    tooltipColumns: associated.tooltipColumns,
    tooltipRowIndexByFeatureId: associated.rowIndexByFeatureId,
  };
}
