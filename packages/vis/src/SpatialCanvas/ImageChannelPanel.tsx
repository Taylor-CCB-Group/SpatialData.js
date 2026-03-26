import type { CSSProperties } from 'react';
import { clampVivSelectionsToAxes } from '@spatialdata/avivatorish';
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

function mergeSelectionRow(
  override: SelectionRow | undefined,
  fallback: SelectionRow,
  axisSizes: AxisSizes | undefined,
): SelectionRow {
  const merged: SelectionRow = { ...fallback, ...override };
  if (axisSizes === undefined) {
    return {
      z: merged.z ?? 0,
      c: merged.c ?? 0,
      t: merged.t ?? 0,
    };
  }
  if (Object.keys(axisSizes).length === 0) {
    return {};
  }
  return clampVivSelectionsToAxes([merged], axisSizes)[0] ?? {};
}

type MergedChannelDisplay = {
  channelCount: number;
  channelIds: string[];
  colors: [number, number, number][];
  contrastLimits: [number, number][];
  channelsVisible: boolean[];
  selections: SelectionRow[];
};

function mergeForDisplay(
  config: ImageLayerConfig,
  defaults: ImageLoaderData | undefined,
  layerId: string,
): MergedChannelDisplay {
  const axisSizes = defaults?.selectionAxisSizes;
  const ch = config.channels;

  const baseColors = defaults?.colors?.length
    ? defaults.colors
    : [[255, 255, 255] as [number, number, number]];
  const baseContrast = defaults?.contrastLimits?.length
    ? defaults.contrastLimits
    : [[0, 65535] as [number, number]];
  const baseVis = defaults?.channelsVisible?.length ? defaults.channelsVisible : [true];

  const baseSelRaw: SelectionRow[] =
    defaults?.selections?.length && defaults.selections.length > 0
      ? defaults.selections.map((s) => ({ ...s }))
      : [emptySelectionRow(axisSizes)];

  const colors = ch?.colors && ch.colors.length > 0 ? [...ch.colors] : [...baseColors];
  const contrastLimits =
    ch?.contrastLimits && ch.contrastLimits.length > 0 ? [...ch.contrastLimits] : [...baseContrast];
  const channelsVisible =
    ch?.channelsVisible && ch.channelsVisible.length > 0 ? [...ch.channelsVisible] : [...baseVis];

  let selections: SelectionRow[];
  if (ch?.selections && ch.selections.length > 0) {
    selections = ch.selections.map((s, i) =>
      mergeSelectionRow(s, baseSelRaw[i] ?? baseSelRaw[0] ?? emptySelectionRow(axisSizes), axisSizes),
    );
  } else {
    selections = baseSelRaw.map((s) => mergeSelectionRow(undefined, s, axisSizes));
  }

  const channelCount = Math.min(
    MAX_CHANNELS,
    Math.max(colors.length, contrastLimits.length, channelsVisible.length, selections.length, 1),
  );

  function pad<T>(arr: T[], len: number, fill: T): T[] {
    const out = arr.slice(0, len);
    while (out.length < len) out.push(fill);
    return out;
  }

  const fillSel = emptySelectionRow(axisSizes);

  const channelIds: string[] = [];
  for (let i = 0; i < channelCount; i++) {
    channelIds.push(ch?.channelIds?.[i] ?? `${layerId}:ch:${i}`);
  }

  return {
    channelCount,
    channelIds,
    colors: pad(colors, channelCount, [255, 255, 255] as [number, number, number]),
    contrastLimits: pad(contrastLimits, channelCount, [0, 65535] as [number, number]),
    channelsVisible: pad(channelsVisible, channelCount, true),
    selections: pad(selections, channelCount, mergeSelectionRow(undefined, fillSel, axisSizes)),
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
  const m = mergeForDisplay(config, defaults, layerId);
  const axisSizes = defaults?.selectionAxisSizes;

  const setChannels = (next: ChannelConfig) => {
    updateLayer(layerId, { channels: { ...config.channels, ...next } });
  };

  const axisActive = (dim: 'z' | 'c' | 't') =>
    axisSizes === undefined ? true : axisSizes[dim] !== undefined;

  const showAxisGrid =
    axisSizes === undefined || Object.keys(axisSizes).some((k) => axisSizes[k as keyof AxisSizes] !== undefined);

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
