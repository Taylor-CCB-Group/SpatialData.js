import type { CSSProperties } from 'react';
import type { ChannelConfig, ImageLayerConfig } from './types';
import type { ImageLoaderData } from './useLayerData';

const MAX_CHANNELS = 6;

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

function mergeForDisplay(
  config: ImageLayerConfig,
  defaults?: ImageLoaderData
): Required<ChannelConfig> & { channelCount: number } {
  const ch = config.channels;
  const baseColors = defaults?.colors?.length
    ? defaults.colors
    : [[255, 255, 255] as [number, number, number]];
  const baseContrast = defaults?.contrastLimits?.length
    ? defaults.contrastLimits
    : [[0, 65535] as [number, number]];
  const baseVis = defaults?.channelsVisible?.length ? defaults.channelsVisible : [true];
  const baseSel = defaults?.selections?.length ? defaults.selections : [{ z: 0, c: 0, t: 0 }];

  const colors = ch?.colors && ch.colors.length > 0 ? [...ch.colors] : [...baseColors];
  const contrastLimits =
    ch?.contrastLimits && ch.contrastLimits.length > 0 ? [...ch.contrastLimits] : [...baseContrast];
  const channelsVisible =
    ch?.channelsVisible && ch.channelsVisible.length > 0 ? [...ch.channelsVisible] : [...baseVis];
  const selections =
    ch?.selections && ch.selections.length > 0
      ? ch.selections.map((s) => ({
          z: s.z ?? 0,
          c: s.c ?? 0,
          t: s.t ?? 0,
        }))
      : baseSel.map((s) => ({ z: s.z ?? 0, c: s.c ?? 0, t: s.t ?? 0 }));

  const channelCount = Math.min(
    MAX_CHANNELS,
    Math.max(colors.length, contrastLimits.length, channelsVisible.length, selections.length, 1)
  );

  function pad<T>(arr: T[], len: number, fill: T): T[] {
    const out = arr.slice(0, len);
    while (out.length < len) out.push(fill);
    return out;
  }

  return {
    channelCount,
    colors: pad(colors, channelCount, [255, 255, 255] as [number, number, number]),
    contrastLimits: pad(contrastLimits, channelCount, [0, 65535] as [number, number]),
    channelsVisible: pad(channelsVisible, channelCount, true),
    selections: pad(selections, channelCount, { z: 0, c: 0, t: 0 }),
  };
}

export interface ImageChannelPanelProps {
  layerId: string;
  config: ImageLayerConfig;
  defaults?: ImageLoaderData;
  updateLayer: (id: string, updates: Partial<ImageLayerConfig>) => void;
}

export function ImageChannelPanel({
  layerId,
  config,
  defaults,
  updateLayer,
}: ImageChannelPanelProps) {
  const m = mergeForDisplay(config, defaults);

  const setChannels = (next: ChannelConfig) => {
    updateLayer(layerId, { channels: { ...config.channels, ...next } });
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ color: '#ccc', fontSize: '12px', fontWeight: 600 }}>
        Channels (max {MAX_CHANNELS})
      </div>
      {Array.from({ length: m.channelCount }, (_, i) => {
        const fingerprint = [
          layerId,
          ...(m.colors[i] ?? []),
          ...(m.contrastLimits[i] ?? []),
          m.channelsVisible[i] ? '1' : '0',
          m.selections[i]?.z ?? '',
          m.selections[i]?.c ?? '',
          m.selections[i]?.t ?? '',
        ].join(':');
        return (
          <div
            key={fingerprint}
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
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 6 }}>
              {(['z', 'c', 't'] as const).map((dim) => (
                <div key={dim}>
                  <span style={labelStyle}>{dim}</span>
                  <input
                    type="number"
                    style={inputStyle}
                    value={m.selections[i]?.[dim] ?? 0}
                    onChange={(e) => {
                      const v = Number(e.target.value);
                      const selections = m.selections.map((s) => ({ ...s }));
                      if (!selections[i]) selections[i] = { z: 0, c: 0, t: 0 };
                      selections[i][dim] = Number.isFinite(v) ? Math.max(0, Math.floor(v)) : 0;
                      setChannels({ selections });
                    }}
                  />
                </div>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}
