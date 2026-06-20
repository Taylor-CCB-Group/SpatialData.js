import type { CSSProperties } from 'react';
import { formatLoadDurationMs, type LayerLoadState } from './useLayerData';

const loadStatsStyle: CSSProperties = {
  color: '#888',
  fontSize: '11px',
};

export interface GeometryLoadStatsProps {
  loadState?: LayerLoadState;
  detailsSuffix?: string;
}

export function GeometryLoadStats({ loadState, detailsSuffix }: GeometryLoadStatsProps) {
  if (!loadState?.geometry) {
    return null;
  }

  const geometryDuration =
    loadState.geometryLoadDurationMs !== undefined
      ? formatLoadDurationMs(loadState.geometryLoadDurationMs)
      : null;

  return (
    <div style={loadStatsStyle}>
      Geometry: {loadState.geometry}
      {geometryDuration ? ` (${geometryDuration})` : ''}
      {detailsSuffix ?? ''}
    </div>
  );
}
