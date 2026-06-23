import type { CSSProperties } from 'react';
import { formatLoadDurationMs, type LayerLoadState } from './useLayerData';

const loadStatsStyle: CSSProperties = {
  color: '#888',
  fontSize: '11px',
};

const errorStyle: CSSProperties = {
  color: '#c96',
  fontSize: '11px',
};

const noticeStyle: CSSProperties = {
  color: '#ca8',
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
      {loadState.geometry === 'ready' && loadState.geometryNotice ? (
        <div style={noticeStyle}>{loadState.geometryNotice}</div>
      ) : null}
      {loadState.geometry === 'loading' && loadState.geometryNotice ? (
        <div style={noticeStyle}>{loadState.geometryNotice}</div>
      ) : null}
      {loadState.geometry === 'error' && loadState.geometryError ? (
        <div style={errorStyle}>{loadState.geometryError}</div>
      ) : null}
    </div>
  );
}
