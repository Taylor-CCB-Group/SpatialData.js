import {
  clampVivSelectionsToAxes,
  MAX_CHANNELS,
  mergeLayerChannelState,
} from '@spatialdata/avivatorish';
import type { CSSProperties } from 'react';
import type { ChannelConfig } from './types';
import type { ImageLoaderData } from './useLayerData';

const inputStyle: CSSProperties = {
  width: '100%',
  boxSizing: 'border-box',
  backgroundColor: '#2a2a2a',
  color: '#eee',
  border: '1px solid #444',
  borderRadius: 4,
  padding: '4px 6px',
  fontSize: '12px',
};

const labelStyle: CSSProperties = {
  color: '#888',
  fontSize: '11px',
  display: 'block',
  marginBottom: 2,
};

type AxisSizes = Partial<Record<'z' | 'c' | 't', number>>;
type SelectionRow = Partial<Record<'z' | 'c' | 't', number>>;

function emptySelectionRow(axisSizes: AxisSizes | undefined): SelectionRow {
  if (axisSizes === undefined) {
    return { z: 0, c: 0, t: 0 };
  }
  const o: SelectionRow = {};
  for (const dim of ['z', 'c', 't'] as const) {
    if (axisSizes[dim] !== undefined) {
      o[dim] = 0;
    }
  }
  return o;
}

export interface ImageChannelPanelProps {
  layerId: string;
  channels: ChannelConfig;
  onChannelsChange: (next: ChannelConfig) => void;
  defaults?: ImageLoaderData;
}

export function ImageChannelPanel({
  layerId,
  channels,
  onChannelsChange,
  defaults,
}: ImageChannelPanelProps) {
  const m = mergeLayerChannelState(channels, defaults, layerId);
  const axisSizes = defaults?.selectionAxisSizes;

  const setChannels = (patch: Partial<ChannelConfig>) => {
    onChannelsChange({ ...channels, ...patch });
  };

  const axisActive = (dim: 'z' | 'c' | 't') =>
    axisSizes === undefined ? true : axisSizes[dim] !== undefined;

  const showAxisGrid =
    axisSizes === undefined ||
    Object.keys(axisSizes).some((k) => axisSizes[k as keyof AxisSizes] !== undefined);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ color: '#ccc', fontSize: '12px', fontWeight: 600 }}>
        Channels (max {MAX_CHANNELS})
      </div>
      {Array.from({ length: m.channelCount }, (_, i) => {
        return (
          <div
            key={m.channelIds[i] ?? `${layerId}:ch:${i}`}
            style={{
              border: '1px solid #333',
              borderRadius: 6,
              padding: 8,
              display: 'flex',
              flexDirection: 'column',
              gap: 6,
            }}
          >
            <span style={{ color: '#666', fontSize: '11px' }}>Channel {i + 1}</span>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={m.channelsVisible[i] ?? true}
                onChange={(e) => {
                  const channelsVisible = [...m.channelsVisible];
                  channelsVisible[i] = e.target.checked;
                  setChannels({ channelsVisible });
                }}
              />
              <span style={{ color: '#aaa', fontSize: '12px' }}>Visible</span>
            </label>
            <div>
              <span style={labelStyle}>RGB</span>
              <div style={{ display: 'flex', gap: 4 }}>
                {(
                  [
                    { band: 'r' as const, j: 0 },
                    { band: 'g' as const, j: 1 },
                    { band: 'b' as const, j: 2 },
                  ] as const
                ).map(({ band, j }) => (
                  <input
                    key={band}
                    type="number"
                    min={0}
                    max={255}
                    style={{ ...inputStyle, flex: 1 }}
                    value={m.colors[i]?.[j] ?? 0}
                    onChange={(e) => {
                      const v = Number(e.target.value);
                      const colors = m.colors.map((c) => [...c] as [number, number, number]);
                      if (!colors[i]) colors[i] = [255, 255, 255];
                      colors[i][j] = Number.isFinite(v) ? Math.min(255, Math.max(0, v)) : 0;
                      setChannels({ colors });
                    }}
                  />
                ))}
              </div>
            </div>
            <div>
              <span style={labelStyle}>Contrast min / max</span>
              <div style={{ display: 'flex', gap: 4 }}>
                <input
                  type="number"
                  style={{ ...inputStyle, flex: 1 }}
                  value={m.contrastLimits[i]?.[0] ?? 0}
                  onChange={(e) => {
                    const v = Number(e.target.value);
                    const contrastLimits = m.contrastLimits.map((c) => [...c] as [number, number]);
                    if (!contrastLimits[i]) contrastLimits[i] = [0, 65535];
                    contrastLimits[i][0] = Number.isFinite(v) ? v : 0;
                    setChannels({ contrastLimits });
                  }}
                />
                <input
                  type="number"
                  style={{ ...inputStyle, flex: 1 }}
                  value={m.contrastLimits[i]?.[1] ?? 65535}
                  onChange={(e) => {
                    const v = Number(e.target.value);
                    const contrastLimits = m.contrastLimits.map((c) => [...c] as [number, number]);
                    if (!contrastLimits[i]) contrastLimits[i] = [0, 65535];
                    contrastLimits[i][1] = Number.isFinite(v) ? v : 65535;
                    setChannels({ contrastLimits });
                  }}
                />
              </div>
            </div>
            {showAxisGrid ? (
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 6 }}>
                {(['z', 'c', 't'] as const).map((dim) => {
                  const active = axisActive(dim);
                  const size = axisSizes?.[dim];
                  const maxIdx = size !== undefined ? Math.max(0, size - 1) : undefined;
                  return (
                    <div key={dim}>
                      <span style={labelStyle}>{dim}</span>
                      {active ? (
                        <input
                          type="number"
                          min={0}
                          max={maxIdx}
                          style={inputStyle}
                          value={m.selections[i]?.[dim] ?? 0}
                          onChange={(e) => {
                            const v = Number(e.target.value);
                            const selections = m.selections.map((s) => ({ ...s }));
                            if (!selections[i]) selections[i] = emptySelectionRow(axisSizes);
                            const clamped = Number.isFinite(v) ? Math.max(0, Math.floor(v)) : 0;
                            selections[i][dim] =
                              maxIdx !== undefined ? Math.min(maxIdx, clamped) : clamped;
                            const cleaned =
                              axisSizes !== undefined && Object.keys(axisSizes).length > 0
                                ? clampVivSelectionsToAxes(selections, axisSizes)
                                : selections;
                            setChannels({ selections: cleaned });
                          }}
                        />
                      ) : (
                        <div
                          style={{
                            ...inputStyle,
                            color: '#666',
                            cursor: 'not-allowed',
                          }}
                          title={`This image has no ${dim.toUpperCase()} axis`}
                        >
                          —
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

/** Demo-shell adapter: updates layer config via SpatialCanvas store actions. */
export interface ImageChannelPanelStoreProps {
  layerId: string;
  config: { channels?: ChannelConfig };
  defaults?: ImageLoaderData;
  updateLayer: (id: string, updates: { channels?: ChannelConfig }) => void;
}

export function ImageChannelPanelFromStore({
  layerId,
  config,
  defaults,
  updateLayer,
}: ImageChannelPanelStoreProps) {
  return (
    <ImageChannelPanel
      layerId={layerId}
      channels={config.channels ?? {}}
      defaults={defaults}
      onChannelsChange={(next) => updateLayer(layerId, { channels: next })}
    />
  );
}
