import type { LabelsElement, ShapesElement } from './models';
import type { SpatialData } from './store';
import {
  loadAssociatedTableFeatureRows,
  loadFeatureRowIndexByFeatureIndex,
} from './tableAssociations';
import type { TableColumnData } from './types';

export type SpatialFeatureTooltipItem = {
  label: string;
  value: string;
};

/** One spatial element's worth of tooltip content (used when aggregating multi-layer picks). */
export type SpatialFeatureTooltipSection = {
  /** Spatial element key (e.g. `Leap034_imc_cell_shapes`). */
  elementKey: string;
  /** Element kind (`shapes`, `labels`, …). */
  elementType: string;
  /** Layer config id when known (e.g. `shapes:Leap034_imc_cell_shapes`). */
  layerId?: string;
  title?: string;
  items: SpatialFeatureTooltipItem[];
};

export type SpatialFeatureTooltipData = {
  /** Picked spatial element key when showing a single-element tooltip. */
  elementKey?: string;
  /** Picked spatial element type when showing a single-element tooltip. */
  elementType?: string;
  /** Layer config id when known. */
  layerId?: string;
  title?: string;
  items: SpatialFeatureTooltipItem[];
  /** Multiple elements under the cursor (bottom-to-top pick order). */
  sections?: SpatialFeatureTooltipSection[];
};

export type SpatialFeatureTooltipElementContext = {
  elementKey: string;
  elementType: string;
  layerId?: string;
};

export function formatSpatialElementLabel(elementType: string, elementKey: string): string {
  return `${elementType}/${elementKey}`;
}

export function attachTooltipElementContext(
  tooltip: Pick<SpatialFeatureTooltipData, 'title' | 'items'>,
  context: SpatialFeatureTooltipElementContext
): SpatialFeatureTooltipData {
  const elementValue = formatSpatialElementLabel(context.elementType, context.elementKey);
  const items = tooltip.items.filter((item) => item.label !== 'element');
  return {
    ...tooltip,
    elementKey: context.elementKey,
    elementType: context.elementType,
    layerId: context.layerId,
    items: [{ label: 'element', value: elementValue }, ...items],
  };
}

export function mergeSpatialFeatureTooltips(
  tooltips: SpatialFeatureTooltipData[]
): SpatialFeatureTooltipData | undefined {
  if (tooltips.length === 0) {
    return undefined;
  }
  if (tooltips.length === 1) {
    return tooltips[0];
  }

  const sections: SpatialFeatureTooltipSection[] = tooltips.map((tooltip) => ({
    elementKey: tooltip.elementKey ?? '',
    elementType: tooltip.elementType ?? '',
    layerId: tooltip.layerId,
    title: tooltip.title,
    items: tooltip.items,
  }));

  return {
    items: [],
    sections,
  };
}

interface BaseTooltipMetadata {
  tooltipSignature?: string;
  tooltipFields?: string[];
  tooltipColumns?: Array<TableColumnData | undefined>;
}

export interface ShapesTooltipMetadata extends BaseTooltipMetadata {
  featureIds?: string[];
  tooltipRowIndices?: Int32Array;
  /** Table row index keyed by picked shape feature id (same contract as labels tooltips). */
  tooltipRowIndexByFeatureId?: Map<string, number>;
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
  const associatedRows = await loadAssociatedTableFeatureRows({
    spatialData,
    kind,
    key,
    extraColumnNames: tooltipFields,
  });

  return {
    tooltipSignature,
    tooltipFields,
    tooltipColumns: associatedRows.extraColumns,
    rowIds: associatedRows.rowIds,
    rowIndexByFeatureId: associatedRows.rowIndexByFeatureId,
  };
}

export async function loadShapesRowIndexByFeatureIndex(
  spatialData: SpatialData | undefined,
  key: string,
  featureIds: string[]
): Promise<Int32Array> {
  return loadFeatureRowIndexByFeatureIndex({
    spatialData,
    kind: 'shapes',
    key,
    featureIds,
  });
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
      tooltipRowIndices = await loadShapesRowIndexByFeatureIndex(
        spatialData,
        element.key,
        featureIds
      );
    }
  }

  return {
    featureIds,
    tooltipSignature: associated.tooltipSignature,
    tooltipFields: associated.tooltipFields,
    tooltipColumns: associated.tooltipColumns,
    tooltipRowIndices,
    tooltipRowIndexByFeatureId: associated.rowIndexByFeatureId,
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
