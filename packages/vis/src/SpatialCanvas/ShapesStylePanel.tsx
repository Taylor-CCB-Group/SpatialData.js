import type { ShapesGeometryKind } from '@spatialdata/core';
import { GeometryLoadStats } from './geometryLoadStats';
import type { LayerLoadState, ShapesLayerLoadedSummary } from './useLayerData';

export function formatShapesGeometryKindLabel(kind: ShapesGeometryKind): string {
  switch (kind) {
    case 'polygon':
      return 'polygons';
    case 'circle':
      return 'circles';
    case 'point':
      return 'points';
  }
}

export interface ShapesStylePanelProps {
  loadState?: LayerLoadState;
  loadedSummary?: ShapesLayerLoadedSummary;
}

export function ShapesStylePanel({ loadState, loadedSummary }: ShapesStylePanelProps) {
  const geometryDetails =
    loadedSummary !== undefined
      ? ` · ${loadedSummary.featureCount.toLocaleString()} ${formatShapesGeometryKindLabel(loadedSummary.geometryKind)}`
      : undefined;

  return <GeometryLoadStats loadState={loadState} detailsSuffix={geometryDetails} />;
}
