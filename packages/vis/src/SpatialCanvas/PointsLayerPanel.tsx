import { DEFAULT_POINTS_MEMORY_CAP, pointsTilingEnabled } from '@spatialdata/core';
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
  // Opt out of the React Compiler — see PointsFeatureFilterPanel. The tiled read is
  // engine-backed and settles asynchronously (the probe), so the compiler would
  // memoize this JSX and leave a dead control on screen.
  'use no memo';
  const actions = useSpatialCanvasActions();
  const { tiled } = usePointsFeatureState(config);
  const currentCap = config.pointsMemoryCap ?? DEFAULT_POINTS_MEMORY_CAP;
  // A tiled layer holds no resident window, so the cap governs nothing. Leaving the
  // control up would put "Max rows kept in memory" directly above "the memory cap
  // does not apply" — each true, the pair nonsense. Same rule as ShowMatchingPoints.
  if (tiled && pointsTilingEnabled(config.pointsTiling)) return null;
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
  const { truncation: t, tiled } = usePointsFeatureState(config);
  // A tiled layer draws from the viewport, not from a resident window, so a
  // truncation count is not a statement about what is on screen. It used to sit
  // directly above "the memory cap does not apply", each true and the pair
  // nonsense — and it survives eviction lag, since this renders before the release.
  if (tiled && pointsTilingEnabled(config.pointsTiling)) return null;
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
 * **On by default** since step 7, for elements that have a usable Morton index. Tiles
 * colour by feature, honour the feature filter (applied inside the row-group scan, so
 * a filtered tile arrives small), and subdivide with zoom. Turning it off re-plans
 * back to the capped preload — worth offering, because the preload keeps the first
 * `cap` rows in FILE order, which on a Morton artifact is a prefix of the Z-curve: a
 * skewed chunk of the slide rather than a sample of it. That comparison is exactly
 * what the toggle is for.
 */
function PointsTilingControl({ config }: { config: PointsLayerConfig }) {
  // Opt out of the React Compiler — see PointsFeatureFilterPanel. The tiling read is
  // engine-backed and settles asynchronously (the probe), so the compiler would
  // memoize this JSX and never show the layer switching over to tiles.
  'use no memo';
  const actions = useSpatialCanvasActions();
  const enabled = pointsTilingEnabled(config.pointsTiling);
  // Through the hook, NOT `engine.isTiled(...)` directly: the hook carries the
  // engine subscription, so this line updates when the probe settles instead of
  // showing whatever was true at the last unrelated render.
  const { tiled } = usePointsFeatureState(config);
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
            ? 'Reading row groups for the viewport, at the zoom you are at — no memory cap applies. The feature filter is applied as tiles are read.'
            : 'This element has no usable Morton index; using the capped preload.'
          : 'Off: showing the first rows of the file up to the memory cap, whatever the viewport. Turn on to read only what you are looking at.'}
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
      <PointsTilingControl config={config} />
      <PointsFeatureFilterPanel config={config} />
    </PointsFeatureStateProvider>
  );
}
