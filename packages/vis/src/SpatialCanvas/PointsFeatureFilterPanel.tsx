import { featureCodeToRgb } from '@spatialdata/layers';
import type { CSSProperties } from 'react';
import { useEffect, useMemo, useState } from 'react';
import { useSpatialCanvasActions } from './context';
import { describeFeatureRowState, featureRowOpacity } from './featureRowState';
import { usePointsFeatureState } from './PointsFeatureState';
import type { PointsLayerConfig } from './types';

// we need a pass on how we manage styles

// The colour swatch IS the picker: this span's background shows the feature's
// effective colour, and a transparent native colour input overlays it. `inline-block`
// + `box-sizing: border-box` make the 12×12 size hold regardless of flex context and
// keep the 1px border inside the box (an inline span would ignore width/height, and a
// content-box border would overflow — the layout bug this replaces).
const colorSwatchStyle: CSSProperties = {
  position: 'relative',
  display: 'inline-block',
  boxSizing: 'border-box',
  width: 12,
  height: 12,
  flexShrink: 0,
  borderRadius: 2,
  border: '1px solid rgba(255, 255, 255, 0.25)',
};

const colorSwatchOverriddenStyle: CSSProperties = {
  borderColor: '#6cb6ff',
  boxShadow: '0 0 0 1px #6cb6ff',
};

const colorInputStyle: CSSProperties = {
  position: 'absolute',
  inset: 0,
  width: '100%',
  height: '100%',
  margin: 0,
  padding: 0,
  border: 'none',
  opacity: 0,
  cursor: 'pointer',
  appearance: 'none',
  WebkitAppearance: 'none',
};

const resetOverrideStyle: CSSProperties = {
  color: '#888',
  fontSize: '11px',
  padding: '0 3px',
  border: '1px solid #444',
  borderRadius: 3,
  background: '#222',
  cursor: 'pointer',
  flexShrink: 0,
};

const hex2 = (value: number): string =>
  Math.max(0, Math.min(255, value)).toString(16).padStart(2, '0');

/** `[r,g,b]` (0–255) → `#rrggbb` for a native colour input's value. */
function rgbToHex([r, g, b]: readonly [number, number, number]): string {
  return `#${hex2(r)}${hex2(g)}${hex2(b)}`;
}

/** `#rrggbb` → `[r,g,b]` (0–255). */
function hexToRgb(hex: string): [number, number, number] {
  const n = Number.parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

const panelStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 6,
  color: '#ccc',
  fontSize: '12px',
};

const listStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 4,
  maxHeight: 180,
  overflowY: 'auto',
  padding: '4px 0',
};

const checkboxLabelStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 6,
};

const helperStyle: CSSProperties = {
  color: '#888',
  fontSize: '11px',
};

const loadingStatStyle: CSSProperties = {
  color: '#6cb6ff',
  fontSize: '11px',
};

const countStyle: CSSProperties = {
  color: '#888',
  fontSize: '11px',
  marginLeft: 'auto',
  flexShrink: 0,
};

const searchStyle: CSSProperties = {
  color: '#ccc',
  fontSize: '12px',
  padding: '4px 6px',
  borderRadius: 4,
  border: '1px solid #444',
  background: '#1a1a1a',
};

const buttonStyle: CSSProperties = {
  alignSelf: 'flex-start',
  color: '#ddd',
  fontSize: '12px',
  padding: '4px 8px',
  borderRadius: 4,
  border: '1px solid #555',
  background: '#2a2a2a',
  cursor: 'pointer',
};

const FEATURE_LIST_SEARCH_THRESHOLD = 100;

function formatFeatureCount(count: number | undefined): string {
  if (count === undefined) {
    return '—';
  }
  return count.toLocaleString();
}

export interface PointsFeatureFilterPanelProps {
  config: PointsLayerConfig;
}

export function PointsFeatureFilterPanel({ config }: PointsFeatureFilterPanelProps) {
  // Opt out of the React Compiler. The usePoints* hooks re-render this component
  // on every engine `notify` (via useSyncExternalStore), but they read mutable
  // engine state the compiler can't see as a dependency, so it would memoize the
  // returned JSX and keep the pre-catalog "not loaded" branch on screen even
  // after the component re-runs with the catalog present. Scoped to this leaf,
  // this is far narrower than the old canvas-wide escape hatch.
  'use no memo';
  const layerId = config.id;
  const { updateLayer } = useSpatialCanvasActions();
  // Reactive points state, read straight from the engine via the surrounding
  // <PointsFeatureStateProvider>.
  const {
    catalog,
    catalogLoading,
    catalogRefining,
    residentCodes,
    loadedMatchingCodes,
    supportsOnDemandLoad,
    matchingLoadState,
    requestCatalog,
    setHighlightedFeature,
  } = usePointsFeatureState(config.featureCodes);

  const [searchQuery, setSearchQuery] = useState('');
  // Request the full-dataset catalog whenever this panel is shown for a layer.
  // The engine dedupes (no-op once the full scan has settled), so this simply
  // upgrades the instant resident-subset preview to the complete list + counts.
  useEffect(() => {
    requestCatalog();
  }, [requestCatalog]);
  // Clear any lingering hover highlight when the panel unmounts (or its layer
  // changes), so an emphasis doesn't stick after the pointer is long gone.
  useEffect(() => () => setHighlightedFeature(null), [setHighlightedFeature]);
  const entries = useMemo(() => catalog?.entries ?? [], [catalog?.entries]);
  const hasCounts = entries.some((entry) => entry.count !== undefined);
  const allSelected = config.featureCodes === undefined;
  const noneSelected = config.featureCodes !== undefined && config.featureCodes.length === 0;
  const selectedCodes = allSelected
    ? new Set(entries.map((entry) => entry.code))
    : new Set(config.featureCodes ?? []);

  const sortedEntries = useMemo(() => {
    const list = [...entries];
    if (hasCounts) {
      list.sort((left, right) => {
        const countDiff = (right.count ?? -1) - (left.count ?? -1);
        if (countDiff !== 0) {
          return countDiff;
        }
        return left.name.localeCompare(right.name);
      });
    } else {
      list.sort((left, right) => left.name.localeCompare(right.name));
    }
    return list;
  }, [entries, hasCounts]);

  const visibleEntries = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    if (!query) {
      return sortedEntries;
    }
    return sortedEntries.filter((entry) => entry.name.toLowerCase().includes(query));
  }, [sortedEntries, searchQuery]);

  const setFeatureCodes = (nextCodes: number[] | undefined) => {
    updateLayer(layerId, { featureCodes: nextCodes });
  };

  // Per-feature colour overrides, keyed by feature NAME (survives code remapping).
  const colorOverrides = config.featureColorOverrides;
  const effectiveRgb = (name: string, code: number): [number, number, number] =>
    colorOverrides?.[name] ?? featureCodeToRgb(code);
  const setColorOverride = (name: string, rgb: [number, number, number]) => {
    updateLayer(layerId, { featureColorOverrides: { ...(colorOverrides ?? {}), [name]: rgb } });
  };
  const clearColorOverride = (name: string) => {
    if (!colorOverrides || !(name in colorOverrides)) {
      return;
    }
    const next = { ...colorOverrides };
    delete next[name];
    updateLayer(layerId, {
      featureColorOverrides: Object.keys(next).length > 0 ? next : undefined,
    });
  };

  const toggleFeature = (code: number, checked: boolean) => {
    const current = new Set(
      allSelected ? entries.map((entry) => entry.code) : (config.featureCodes ?? [])
    );
    if (checked) {
      current.add(code);
    } else {
      current.delete(code);
    }
    if (current.size === 0) {
      setFeatureCodes([]);
      return;
    }
    if (current.size === entries.length) {
      setFeatureCodes(undefined);
      return;
    }
    setFeatureCodes([...current].sort((left, right) => left - right));
  };

  if (catalogLoading) {
    return (
      <div style={panelStyle}>
        <div style={helperStyle}>Loading features…</div>
      </div>
    );
  }

  if (catalog === undefined) {
    return (
      <div style={panelStyle}>
        <div style={helperStyle}>Feature list not loaded.</div>
        <button type="button" style={buttonStyle} onClick={() => requestCatalog()}>
          Load feature list
        </button>
      </div>
    );
  }

  if (!catalog || entries.length === 0) {
    return (
      <div style={panelStyle}>
        <div style={helperStyle}>
          {catalog === null
            ? 'No feature catalog available for this points layer (missing feature_key or unsupported encoding for this dataset size).'
            : 'No features found in the feature catalog.'}
        </div>
      </div>
    );
  }

  const selectedCount = noneSelected ? 0 : allSelected ? entries.length : selectedCodes.size;
  const showSearch = entries.length > FEATURE_LIST_SEARCH_THRESHOLD;
  // A feature's points are "loaded" (renderable now, not greyed) if it is in the
  // instant resident preview OR its points are currently on screen via the
  // last-completed feature-index scan (`loadedMatchingCodes`). Keying off what's
  // rendered — not the current scan's settled state — keeps already-loaded
  // features un-greyed while a newly added feature's scan is still in flight.
  const residentKnown = residentCodes !== undefined;
  const scanning = matchingLoadState?.loading ?? false;
  const rowInfo = (code: number) => {
    const resident = residentKnown && (residentCodes?.has(code) ?? false);
    const rendered = loadedMatchingCodes?.has(code) ?? false;
    const selected = !noneSelected && (allSelected || selectedCodes.has(code));
    const state = describeFeatureRowState({
      resident,
      rendered,
      selected,
      scanning,
      supportsOnDemandLoad,
      residentKnown,
    });
    return { resident, rendered, selected, state };
  };
  const notLoadedCount = residentKnown
    ? entries.reduce((total, entry) => total + (rowInfo(entry.code).state.greyed ? 1 : 0), 0)
    : 0;

  return (
    <div style={panelStyle}>
      <div>
        Features ({catalog.featureKey})
        <span style={helperStyle}>
          {' '}
          · {selectedCount}/{entries.length} selected
          {hasCounts ? ' · sorted by count' : ''}
        </span>
      </div>
      {catalogRefining ? <div style={helperStyle}>Loading the full feature list…</div> : null}
      {notLoadedCount > 0 ? (
        <div style={helperStyle}>
          {notLoadedCount} of {entries.length} feature{entries.length === 1 ? '' : 's'}{' '}
          {supportsOnDemandLoad
            ? 'not loaded yet (greyed below) — selecting one loads it on demand.'
            : "not in the loaded sample (greyed below) — this dataset has no feature index, so they can't be shown until the row cap is raised or it's rewritten with one."}
        </div>
      ) : null}
      {matchingLoadState ? (
        <div style={matchingLoadState.loading ? loadingStatStyle : helperStyle}>
          {matchingLoadState.loading
            ? `Loading selected features… ${matchingLoadState.matchedRows.toLocaleString()} points so far`
            : matchingLoadState.covered
              ? `Selection served from ${matchingLoadState.matchedRows.toLocaleString()} points in memory (no re-scan)`
              : `${matchingLoadState.matchedRows.toLocaleString()} points loaded for this selection`}
        </div>
      ) : null}
      <label style={checkboxLabelStyle}>
        <input
          type="checkbox"
          checked={allSelected}
          onChange={(event) => {
            if (event.target.checked) {
              setFeatureCodes(undefined);
            }
          }}
        />
        All features
      </label>
      <label style={checkboxLabelStyle}>
        <input
          type="checkbox"
          checked={noneSelected}
          onChange={(event) => {
            if (event.target.checked) {
              setFeatureCodes([]);
            }
          }}
        />
        Deselect all
      </label>
      {showSearch ? (
        <input
          type="search"
          placeholder="Search features…"
          value={searchQuery}
          onChange={(event) => setSearchQuery(event.target.value)}
          style={searchStyle}
        />
      ) : null}
      <div style={listStyle}>
        {visibleEntries.map((entry) => {
          const { resident, rendered, selected, state } = rowInfo(entry.code);
          const countStr =
            entry.count !== undefined ? ` · ${entry.count.toLocaleString()} pts` : '';
          // Multi-line diagnostic: the human state + reason, then the raw signals
          // that drove the decision (what made this row grey / not grey).
          const overridden = colorOverrides?.[entry.name] !== undefined;
          const rgb = effectiveRgb(entry.name, entry.code);
          const title =
            `${entry.name} · code ${entry.code}${countStr}\n` +
            `${state.label}: ${state.reason}\n` +
            `[resident=${resident ? 'y' : 'n'} rendered=${rendered ? 'y' : 'n'} ` +
            `selected=${selected ? 'y' : 'n'} scan=${scanning ? 'running' : 'idle'}]`;
          return (
            <label
              key={entry.code}
              style={{ ...checkboxLabelStyle, opacity: featureRowOpacity(state) }}
              title={title}
              onMouseEnter={() => setHighlightedFeature(entry.code)}
              onMouseLeave={() => setHighlightedFeature(null)}
            >
              <input
                type="checkbox"
                checked={selected}
                onChange={(event) => toggleFeature(entry.code, event.target.checked)}
              />
              {/* Swatch = colour picker: this span's background is the effective
                  colour and a transparent colour input overlays it. Interactive content
                  inside the label, so operating it does not toggle the checkbox. */}
              <span
                style={{
                  ...colorSwatchStyle,
                  background: `rgb(${rgb[0]}, ${rgb[1]}, ${rgb[2]})`,
                  ...(overridden ? colorSwatchOverriddenStyle : {}),
                }}
                title={`${entry.name} colour${overridden ? ' (overridden)' : ''}`}
              >
                <input
                  type="color"
                  aria-label={`${entry.name} colour`}
                  value={rgbToHex(rgb)}
                  style={colorInputStyle}
                  onClick={(event) => event.stopPropagation()}
                  onChange={(event) => setColorOverride(entry.name, hexToRgb(event.target.value))}
                />
              </span>
              <span>
                {entry.name}
                {state.greyed ? ' ·' : ''}
              </span>
              {overridden ? (
                <button
                  type="button"
                  style={resetOverrideStyle}
                  title="Reset to default colour"
                  onClick={(event) => {
                    event.stopPropagation();
                    event.preventDefault();
                    clearColorOverride(entry.name);
                  }}
                >
                  ⟲
                </button>
              ) : null}
              {hasCounts ? <span style={countStyle}>{formatFeatureCount(entry.count)}</span> : null}
            </label>
          );
        })}
        {showSearch && visibleEntries.length === 0 ? (
          <div style={helperStyle}>No features match your search.</div>
        ) : null}
      </div>
    </div>
  );
}
