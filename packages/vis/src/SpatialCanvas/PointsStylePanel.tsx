import type { CSSProperties } from 'react';
import {
  DEFAULT_POINT_RADIUS_MAX_PIXELS,
  DEFAULT_POINT_RADIUS_MIN_PIXELS,
  DEFAULT_POINT_SIZE,
} from './renderers/pointsRenderer';
import type { PointsLayerConfig } from './types';

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
  tileLoadingMessage?: string | null;
  supportsTileDebugOverlay?: boolean;
  updateLayer: (id: string, updates: Partial<PointsLayerConfig>) => void;
}

export function PointsStylePanel({
  layerId,
  config,
  tileLoadingMessage,
  supportsTileDebugOverlay = false,
  updateLayer,
}: PointsStylePanelProps) {
  return (
    <>
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
