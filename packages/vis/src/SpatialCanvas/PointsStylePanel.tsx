import type { CSSProperties } from 'react';
import {
  DEFAULT_POINTS_MEMORY_CAP,
  DEFAULT_POINTS_RENDER_CAP,
  POINTS_PRELOAD_MAX_ROWS,
} from '@spatialdata/core';
import {
  DEFAULT_POINT_RADIUS_MAX_PIXELS,
  DEFAULT_POINT_RADIUS_MIN_PIXELS,
  DEFAULT_POINT_SIZE,
} from './renderers/pointsRenderer';
import type { PointsLayerConfig } from './types';
import { GeometryLoadStats } from './geometryLoadStats';
import type { LayerLoadState } from './useLayerData';

const rangeLabelStyle: CSSProperties = {
  color: '#ccc',
  fontSize: '12px',
  display: 'flex',
  flexDirection: 'column',
  gap: 4,
};

const numberInputStyle: CSSProperties = {
  color: '#ccc',
  fontSize: '12px',
  padding: '4px 6px',
  borderRadius: 4,
  border: '1px solid #444',
  background: '#1a1a1a',
  width: '100%',
};

const helperStyle: CSSProperties = {
  color: '#888',
  fontSize: '11px',
};

const tileProgressStyle: CSSProperties = {
  color: '#aaa',
  fontSize: '11px',
};

export function preloadedPointCount(data: { shape: number[]; data: ArrayLike<number>[] }): number {
  if (data.shape.length >= 2 && Number.isFinite(data.shape[1])) {
    return data.shape[1];
  }
  return data.data[0]?.length ?? data.shape[0] ?? 0;
}

export function preloadedPointCountSuffix(
  data: {
    shape: number[];
    data: ArrayLike<number>[];
    totalRowCount?: number;
    preloadTruncated?: boolean;
    filterActive?: boolean;
    scannedRowCount?: number;
  }
): string | undefined {
  const loaded = preloadedPointCount(data);
  if (data.filterActive && data.scannedRowCount !== undefined) {
    return ` · ${loaded.toLocaleString()} matching (scanned ${data.scannedRowCount.toLocaleString()} rows)`;
  }
  if (data.preloadTruncated && data.totalRowCount !== undefined) {
    return ` · ${loaded.toLocaleString()} of ${data.totalRowCount.toLocaleString()} points loaded`;
  }
  return ` · ${loaded.toLocaleString()} points loaded`;
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
  pointCountSuffix?: string;
  tileLoadingMessage?: string | null;
  supportsTileDebugOverlay?: boolean;
  updateLayer: (id: string, updates: Partial<PointsLayerConfig>) => void;
}

export function PointsStylePanel({
  layerId,
  config,
  loadState,
  pointCountSuffix,
  tileLoadingMessage,
  supportsTileDebugOverlay = false,
  updateLayer,
}: PointsStylePanelProps) {
  const memoryCap = config.pointsMemoryCap ?? DEFAULT_POINTS_MEMORY_CAP;
  const renderCap = config.pointsRenderCap ?? DEFAULT_POINTS_RENDER_CAP;

  return (
    <>
      <GeometryLoadStats loadState={loadState} detailsSuffix={pointCountSuffix} />
      <label style={rangeLabelStyle}>
        Memory cap (rows)
        <input
          type="number"
          min={1}
          max={POINTS_PRELOAD_MAX_ROWS}
          step={100_000}
          value={memoryCap}
          style={numberInputStyle}
          onChange={(event) => {
            const parsed = Number(event.target.value);
            if (!Number.isFinite(parsed) || parsed <= 0) {
              return;
            }
            updateLayer(layerId, { pointsMemoryCap: Math.floor(parsed) });
          }}
        />
        <span style={helperStyle}>
          Max rows retained in memory when loading (default{' '}
          {DEFAULT_POINTS_MEMORY_CAP.toLocaleString()}).
        </span>
      </label>
      <label style={rangeLabelStyle}>
        Render cap (rows)
        <input
          type="number"
          min={0}
          max={POINTS_PRELOAD_MAX_ROWS}
          step={100_000}
          value={renderCap}
          style={numberInputStyle}
          onChange={(event) => {
            const parsed = Number(event.target.value);
            if (!Number.isFinite(parsed)) {
              return;
            }
            updateLayer(layerId, {
              pointsRenderCap: parsed <= 0 ? 0 : Math.floor(parsed),
            });
          }}
        />
        <span style={helperStyle}>
          Max rows drawn after filtering (0 = no cap). Can be lower than memory cap.
        </span>
      </label>
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
