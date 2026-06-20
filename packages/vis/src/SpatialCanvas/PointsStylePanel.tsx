import type { CSSProperties } from 'react';
import {
  DEFAULT_POINT_RADIUS_MAX_PIXELS,
  DEFAULT_POINT_RADIUS_MIN_PIXELS,
  DEFAULT_POINT_SIZE,
} from './renderers/pointsRenderer';
import type { PointsLayerConfig } from './types';
import { formatLoadDurationMs, type LayerLoadState } from './useLayerData';

const rangeLabelStyle: CSSProperties = {
  color: '#ccc',
  fontSize: '12px',
  display: 'flex',
  flexDirection: 'column',
  gap: 4,
};

const tileProgressStyle: CSSProperties = {
  color: '#aaa',
  fontSize: '11px',
};

const loadStatsStyle: CSSProperties = {
  color: '#888',
  fontSize: '11px',
};

export function preloadedPointCount(data: { shape: number[]; data: ArrayLike<number>[] }): number {
  if (data.shape.length >= 2 && Number.isFinite(data.shape[1])) {
    return data.shape[1];
  }
  return data.data[0]?.length ?? data.shape[0] ?? 0;
}

const checkboxLabelStyle: CSSProperties = {
  color: '#ccc',
  fontSize: '12px',
  display: 'flex',
  alignItems: 'center',
  gap: 6,
};

export interface PointsStylePanelProps {
  layerId: string;
  config: PointsLayerConfig;
  loadState?: LayerLoadState;
  preloadedPointCount?: number;
  tileLoadingMessage?: string | null;
  supportsTileDebugOverlay?: boolean;
  updateLayer: (id: string, updates: Partial<PointsLayerConfig>) => void;
}

export function PointsStylePanel({
  layerId,
  config,
  loadState,
  preloadedPointCount,
  tileLoadingMessage,
  supportsTileDebugOverlay = false,
  updateLayer,
}: PointsStylePanelProps) {
  const geometryDuration =
    loadState?.geometryLoadDurationMs !== undefined &&
    (loadState.geometry === 'ready' || loadState.geometry === 'error')
      ? formatLoadDurationMs(loadState.geometryLoadDurationMs)
      : null;

  return (
    <>
      {loadState?.geometry ? (
        <div style={loadStatsStyle}>
          Geometry: {loadState.geometry}
          {geometryDuration ? ` (${geometryDuration})` : ''}
          {preloadedPointCount !== undefined
            ? ` · ${preloadedPointCount.toLocaleString()} points loaded`
            : ''}
        </div>
      ) : null}
      <label style={rangeLabelStyle}>
        Point size
        <input
          type="range"
          min={0.1}
          max={12}
          step={0.25}
          value={config.pointSize ?? DEFAULT_POINT_SIZE}
          onChange={(e) =>
            updateLayer(layerId, {
              pointSize: Number(e.target.value),
            })
          }
        />
      </label>
      <label style={rangeLabelStyle}>
        Min radius (px)
        <input
          type="range"
          min={0}
          max={8}
          step={0.1}
          value={config.pointRadiusMinPixels ?? DEFAULT_POINT_RADIUS_MIN_PIXELS}
          onChange={(e) =>
            updateLayer(layerId, {
              pointRadiusMinPixels: Number(e.target.value),
            })
          }
        />
      </label>
      <label style={rangeLabelStyle}>
        Max radius (px)
        <input
          type="range"
          min={1}
          max={16}
          step={0.1}
          value={config.pointRadiusMaxPixels ?? DEFAULT_POINT_RADIUS_MAX_PIXELS}
          onChange={(e) =>
            updateLayer(layerId, {
              pointRadiusMaxPixels: Number(e.target.value),
            })
          }
        />
      </label>
      {supportsTileDebugOverlay ? (
        <label style={checkboxLabelStyle}>
          <input
            type="checkbox"
            checked={config.showTileDebugOverlay ?? true}
            onChange={(e) =>
              updateLayer(layerId, {
                showTileDebugOverlay: e.target.checked,
              })
            }
          />
          Show tile debug overlay
        </label>
      ) : null}
      {tileLoadingMessage ? (
        <div style={tileProgressStyle}>{tileLoadingMessage}</div>
      ) : null}
    </>
  );
}
