import { DEFAULT_POINTS_MEMORY_CAP } from '@spatialdata/core';
import type { PointsDataEngine, PointsLoadTarget } from '@spatialdata/layers';
import { PointsFeatureFilterPanel } from './PointsFeatureFilterPanel';
import { PointsFeatureStateProvider, usePointsFeatureState } from './PointsFeatureState';
import { useSpatialCanvasActions } from './context';
import type { PointsLayerConfig } from './types';

export interface PointsLayerPanelProps {
  config: PointsLayerConfig;
  /** The live engine (render path's owner) — the panel subscribes to it for
   * reactive catalog / scan state instead of reading prop-drilled getters. */
  engine: PointsDataEngine;
  /** Resolve a layer id to the engine's load target. Sourced from the renderer
   * hook result so panel reads hit the same cache keys the render writes. */
  resolveTarget: (layerId: string) => PointsLoadTarget | undefined;
}

function PointsMemoryCap({ config }: { config: PointsLayerConfig }) {
  const actions = useSpatialCanvasActions();
  const currentCap = config.pointsMemoryCap ?? DEFAULT_POINTS_MEMORY_CAP;
  // Discrete options (one reload per choice, vs. a free number
  // input that would reload on every keystroke). Include the
  // current value so a saved config off the preset list still
  // shows correctly.
  const capOptions = Array.from(
    new Set([1, 2, 4, 8, 16].map((m) => m * 1_000_000).concat(currentCap))
  ).sort((a, b) => a - b);
  return (
    <label
      style={{
        color: '#ccc',
        fontSize: '12px',
        display: 'flex',
        flexDirection: 'column',
        gap: 4,
      }}
    >
      Memory cap
      <select
        value={currentCap}
        onChange={(e) =>
          actions.updateLayer(config.id, {
            pointsMemoryCap: Number(e.target.value),
          })
        }
        style={{
          color: '#ccc',
          fontSize: '12px',
          padding: '4px 6px',
          borderRadius: 4,
          border: '1px solid #444',
          background: '#1a1a1a',
        }}
      >
        {capOptions.map((cap) => (
          <option key={cap} value={cap}>
            {`${(cap / 1_000_000).toLocaleString(undefined, {
              maximumFractionDigits: 1,
            })}M rows`}
            {cap === DEFAULT_POINTS_MEMORY_CAP ? ' (default)' : ''}
          </option>
        ))}
      </select>
      <span style={{ color: '#888', fontSize: '11px' }}>
        Max rows kept in memory. Higher shows more points; picking is limited to ~16.7M/layer.
      </span>
    </label>
  );
}

function ShowMatchingPoints({ config }: { config: PointsLayerConfig }) {
  // Opt out of the React Compiler — see PointsFeatureFilterPanel. The truncation
  // read is engine-backed and updates on notify; the compiler would otherwise
  // memoize this line's JSX and never repaint it as the scan progresses.
  'use no memo';
  const { truncation: t } = usePointsFeatureState(config.featureCodes);
  if (!t) return null;
  // Report the batch held in memory (always true), NOT a per-selection matched
  // count: t.loaded is the covered-batch size, which overstates the selection
  // when it filters that batch in memory. A precise selection count needs the
  // engine to track it — deferred to the redesign (punch-list F3/D4).
  const message = t.truncated
    ? `${t.loaded.toLocaleString()}${
        t.total !== undefined ? ` of ${t.total.toLocaleString()}` : ''
      } points in memory — capped; raise the cap for more.`
    : t.filtered
      ? `${t.loaded.toLocaleString()} points in memory; view filtered to selection.`
      : `All ${t.loaded.toLocaleString()} points loaded (not capped).`;
  return (
    <span
      style={{
        color: t.truncated ? '#d0a24c' : '#888',
        fontSize: '11px',
      }}
    >
      {message}
    </span>
  );
}

export default function PointsLayerPanel({ config, engine, resolveTarget }: PointsLayerPanelProps) {
  return (
    <PointsFeatureStateProvider engine={engine} target={resolveTarget(config.id)}>
      <PointsMemoryCap config={config} />
      <ShowMatchingPoints config={config} />
      <PointsFeatureFilterPanel config={config} />
    </PointsFeatureStateProvider>
  );
}
