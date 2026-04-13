import type { CSSProperties } from 'react';
import { clampVivSelectionsToAxes } from '@spatialdata/avivatorish';
import type { LabelsLayerConfig } from './types';
import type { LabelsLoaderData } from './useLayerData';

const MAX_CHANNELS = 7;

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
type LabelsChannelsConfig = NonNullable<LabelsLayerConfig['channels']>;

type MergedLabelsDisplay = {
  channelCount: number;
  channelIds: string[];
  colors: [number, number, number][];
  channelsVisible: boolean[];
  channelOpacities: number[];
  channelOutlineOpacities: number[];
  channelsFilled: boolean[];
  channelStrokeWidths: number[];
  selections: SelectionRow[];
};

function emptySelectionRow(axisSizes: AxisSizes | undefined): SelectionRow {
  if (axisSizes === undefined) {
    return { z: 0, c: 0, t: 0 };
  }
  const next: SelectionRow = {};
  for (const dim of ['z', 'c', 't'] as const) {
    if (axisSizes[dim] !== undefined) {
      next[dim] = 0;
    }
  }
  return next;
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

function pad<T>(arr: T[], len: number, fill: T): T[] {
  const next = arr.slice(0, len);
  while (next.length < len) {
    next.push(fill);
  }
  return next;
}

function mergeForDisplay(
  config: LabelsLayerConfig,
  defaults: LabelsLoaderData | undefined,
  layerId: string,
): MergedLabelsDisplay {
  const axisSizes = defaults?.selectionAxisSizes;
  const ch = config.channels;
  const baseColors = defaults?.colors?.length
    ? defaults.colors
    : [[255, 255, 255] as [number, number, number]];
  const baseVisible = defaults?.channelsVisible?.length ? defaults.channelsVisible : [true];
  const baseFillOpacities = defaults?.channelOpacities?.length ? defaults.channelOpacities : [0.18];
  const baseOutlineOpacities = defaults?.channelOutlineOpacities?.length
    ? defaults.channelOutlineOpacities
    : [0.95];
  const baseFilled = defaults?.channelsFilled?.length ? defaults.channelsFilled : [true];
  const baseStrokeWidths = defaults?.channelStrokeWidths?.length
    ? defaults.channelStrokeWidths
    : [1.5];
  const baseSelections =
    defaults?.selections?.length && defaults.selections.length > 0
      ? defaults.selections.map((selection) => ({ ...selection }))
      : [emptySelectionRow(axisSizes)];

  const colors = ch?.colors && ch.colors.length > 0 ? [...ch.colors] : [...baseColors];
  const channelsVisible =
    ch?.channelsVisible && ch.channelsVisible.length > 0
      ? [...ch.channelsVisible]
      : [...baseVisible];
  const channelOpacities =
    ch?.channelOpacities && ch.channelOpacities.length > 0
      ? [...ch.channelOpacities]
      : [...baseFillOpacities];
  const channelOutlineOpacities =
    ch?.channelOutlineOpacities && ch.channelOutlineOpacities.length > 0
      ? [...ch.channelOutlineOpacities]
      : [...baseOutlineOpacities];
  const channelsFilled =
    ch?.channelsFilled && ch.channelsFilled.length > 0
      ? [...ch.channelsFilled]
      : [...baseFilled];
  const channelStrokeWidths =
    ch?.channelStrokeWidths && ch.channelStrokeWidths.length > 0
      ? [...ch.channelStrokeWidths]
      : [...baseStrokeWidths];

  const selections =
    ch?.selections && ch.selections.length > 0
      ? ch.selections.map((selection, index) =>
        mergeSelectionRow(
          selection,
          baseSelections[index] ?? baseSelections[0] ?? emptySelectionRow(axisSizes),
          axisSizes,
        ),
      )
      : baseSelections.map((selection) => mergeSelectionRow(undefined, selection, axisSizes));

  const channelCount = Math.min(
    MAX_CHANNELS,
    Math.max(
      colors.length,
      channelsVisible.length,
      channelOpacities.length,
      channelOutlineOpacities.length,
      channelsFilled.length,
      channelStrokeWidths.length,
      selections.length,
      1,
    ),
  );

  const fillSelection = emptySelectionRow(axisSizes);
  const channelIds = Array.from(
    { length: channelCount },
    (_, index) => ch?.channelIds?.[index] ?? `${layerId}:labels:${index}`,
  );

  return {
    channelCount,
    channelIds,
    colors: pad(colors, channelCount, [255, 255, 255] as [number, number, number]),
    channelsVisible: pad(channelsVisible, channelCount, true),
    channelOpacities: pad(channelOpacities, channelCount, 0.18),
    channelOutlineOpacities: pad(channelOutlineOpacities, channelCount, 0.95),
    channelsFilled: pad(channelsFilled, channelCount, true),
    channelStrokeWidths: pad(channelStrokeWidths, channelCount, 1.5),
    selections: pad(
      selections,
      channelCount,
      mergeSelectionRow(undefined, fillSelection, axisSizes),
    ),
  };
}

export interface LabelsChannelPanelProps {
  layerId: string;
  config: LabelsLayerConfig;
  defaults?: LabelsLoaderData;
  updateLayer: (id: string, updates: Partial<LabelsLayerConfig>) => void;
}

export function LabelsChannelPanel({
  layerId,
  config,
  defaults,
  updateLayer,
}: LabelsChannelPanelProps) {
  const m = mergeForDisplay(config, defaults, layerId);
  const axisSizes = defaults?.selectionAxisSizes;

  const setChannels = (next: Partial<LabelsChannelsConfig>) => {
    updateLayer(layerId, { channels: { ...config.channels, ...next } });
  };

  const axisActive = (dim: 'z' | 'c' | 't') =>
    axisSizes === undefined ? true : axisSizes[dim] !== undefined;
  const showAxisGrid =
    axisSizes === undefined || Object.keys(axisSizes).some((k) => axisSizes[k as keyof AxisSizes] !== undefined);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ color: '#ccc', fontSize: '12px', fontWeight: 600 }}>
        Labels channels (max {MAX_CHANNELS})
      </div>
      {Array.from({ length: m.channelCount }, (_, i) => (
        <div
          key={m.channelIds[i] ?? `${layerId}:labels:${i}`}
          style={{
            border: '1px solid #333',
            borderRadius: 6,
            padding: 8,
            display: 'flex',
            flexDirection: 'column',
            gap: 8,
          }}
        >
          <span style={{ color: '#666', fontSize: '11px' }}>Channel {i + 1}</span>
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
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
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={m.channelsFilled[i] ?? true}
                onChange={(e) => {
                  const channelsFilled = [...m.channelsFilled];
                  channelsFilled[i] = e.target.checked;
                  setChannels({ channelsFilled });
                }}
              />
              <span style={{ color: '#aaa', fontSize: '12px' }}>Fill</span>
            </label>
          </div>
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
                    const value = Number(e.target.value);
                    const colors = m.colors.map((color) => [...color] as [number, number, number]);
                    if (!colors[i]) colors[i] = [255, 255, 255];
                    colors[i][j] = Number.isFinite(value)
                      ? Math.min(255, Math.max(0, value))
                      : 0;
                    setChannels({ colors });
                  }}
                />
              ))}
            </div>
          </div>
          <div>
            <span style={labelStyle}>Fill opacity ({(m.channelOpacities[i] ?? 0).toFixed(2)})</span>
            <input
              type="range"
              min={0}
              max={1}
              step={0.01}
              value={m.channelOpacities[i] ?? 0.18}
              onChange={(e) => {
                const channelOpacities = [...m.channelOpacities];
                channelOpacities[i] = Number(e.target.value);
                setChannels({ channelOpacities });
              }}
            />
          </div>
          <div>
            <span style={labelStyle}>
              Outline opacity ({(m.channelOutlineOpacities[i] ?? 0).toFixed(2)})
            </span>
            <input
              type="range"
              min={0}
              max={1}
              step={0.01}
              value={m.channelOutlineOpacities[i] ?? 0.95}
              onChange={(e) => {
                const channelOutlineOpacities = [...m.channelOutlineOpacities];
                channelOutlineOpacities[i] = Number(e.target.value);
                setChannels({ channelOutlineOpacities });
              }}
            />
          </div>
          <div>
            <span style={labelStyle}>Outline width</span>
            <input
              type="number"
              min={0}
              max={8}
              step={0.25}
              style={inputStyle}
              value={m.channelStrokeWidths[i] ?? 1.5}
              onChange={(e) => {
                const nextValue = Number(e.target.value);
                const channelStrokeWidths = [...m.channelStrokeWidths];
                channelStrokeWidths[i] = Number.isFinite(nextValue)
                  ? Math.max(0, nextValue)
                  : 1.5;
                setChannels({ channelStrokeWidths });
              }}
            />
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
                        step={1}
                        style={inputStyle}
                        value={m.selections[i]?.[dim] ?? 0}
                        onChange={(e) => {
                          const nextValue = Number(e.target.value);
                          const selections = m.selections.map((selection) => ({ ...selection }));
                          const nextSelection = { ...(selections[i] ?? {}) };
                          nextSelection[dim] = Number.isFinite(nextValue) ? Math.max(0, nextValue) : 0;
                          selections[i] = mergeSelectionRow(
                            nextSelection,
                            emptySelectionRow(axisSizes),
                            axisSizes,
                          );
                          setChannels({ selections });
                        }}
                      />
                    ) : (
                      <div style={{ ...inputStyle, color: '#666' }}>n/a</div>
                    )}
                  </div>
                );
              })}
            </div>
          ) : null}
        </div>
      ))}
    </div>
  );
}
