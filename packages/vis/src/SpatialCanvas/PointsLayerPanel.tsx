import { DEFAULT_POINTS_MEMORY_CAP } from '@spatialdata/core';
import type { PointsDataEngine, PointsLoadTarget } from '@spatialdata/layers';
import { useSpatialCanvasActions } from './context';
import { PointsFeatureFilterPanel } from './PointsFeatureFilterPanel';
import { PointsFeatureStateProvider, usePointsFeatureState } from './PointsFeatureState';
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
  const { truncation: t } = usePointsFeatureState(config);
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

function PointSizeControl({ config }: { config: PointsLayerConfig }) {
  const actions = useSpatialCanvasActions();
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
      Point size ({(config.pointSize ?? 1).toFixed(2)})
      <input
        type="range"
        min={0.01}
        max={12}
        step={0.01}
        value={config.pointSize ?? 1}
        onChange={(e) =>
          actions.updateLayer(config.id, {
            pointSize: Number(e.target.value),
          })
        }
      />
    </label>
  );
}

/**
 * Morton viewport tiling (D5), and its tile-status overlay.
 *
 * Opt-in while the tiled path is being built out: it draws flat-coloured tiles and
 * does not yet honour the feature filter, so it is not something to switch on behind
 * a user's back. Switching it on re-plans — the probe runs, and if the element is a
 * Morton artifact the resident preload is dropped in favour of viewport tiles.
 */
function PointsTilingControl({
  config,
  engine,
}: {
  config: PointsLayerConfig;
  engine: PointsDataEngine;
}) {
  // Opt out of the React Compiler — the `isTiled` read is engine-backed and settles
  // asynchronously (the probe), so a memoized version of this JSX would never show
  // the layer switching over to tiles.
  'use no memo';
  const actions = useSpatialCanvasActions();
  const enabled = config.pointsTiling === 'auto';
  const tiled = engine.isTiled(config.elementKey);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <label style={{ color: '#ccc', fontSize: '12px', display: 'flex', gap: 6 }}>
        <input
          type="checkbox"
          checked={enabled}
          onChange={(e) =>
            actions.updateLayer(config.id, {
              pointsTiling: e.target.checked ? 'auto' : 'off',
            })
          }
        />
        Viewport tiles (Morton)
      </label>
      {enabled && (
        <label style={{ color: '#ccc', fontSize: '12px', display: 'flex', gap: 6 }}>
          <input
            type="checkbox"
            checked={config.showTileDebugOverlay === true}
            onChange={(e) =>
              actions.updateLayer(config.id, { showTileDebugOverlay: e.target.checked })
            }
          />
          Tile debug overlay
        </label>
      )}
      <span style={{ color: '#888', fontSize: '11px' }}>
        {enabled
          ? tiled
            ? 'Reading row groups for the viewport — the memory cap does not apply.'
            : 'This element has no Morton index; using the capped preload.'
          : 'Load only the viewport, from a Morton-sorted element. Flat colour for now.'}
      </span>
    </div>
  );
}

export default function PointsLayerPanel({ config, engine, resolveTarget }: PointsLayerPanelProps) {
  return (
    <PointsFeatureStateProvider engine={engine} target={resolveTarget(config.id)}>
      <PointSizeControl config={config} />
      <PointsMemoryCap config={config} />
      <ShowMatchingPoints config={config} />
      <PointsTilingControl config={config} engine={engine} />
      <PointsFeatureFilterPanel config={config} />
    </PointsFeatureStateProvider>
  );
}
