import { featureCodeToCssColor } from '@spatialdata/layers';
import type { CSSProperties } from 'react';
import { useEffect, useMemo, useState } from 'react';
import { usePointsFeatureState } from './PointsFeatureState';
import { useSpatialCanvasActions } from './context';
import type { PointsLayerConfig } from './types';

// we need a pass on how we manage styles
const swatchStyle: CSSProperties = {
  width: 10,
  height: 10,
  borderRadius: 2,
  flexShrink: 0,
  border: '1px solid rgba(255, 255, 255, 0.25)',
};

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

/** Why a feature row is (or isn't) greyed — drives both the dimming and the
 * diagnostic tooltip so they can never disagree. */
export type FeatureRowTone = 'resident' | 'loaded' | 'cached' | 'loading' | 'noIndex' | 'notLoaded';

export interface FeatureRowState {
  tone: FeatureRowTone;
  /** Whether the row is dimmed (its points are not on screen). */
  greyed: boolean;
  /** Short state label, e.g. "loaded", "loading", "not loaded". */
  label: string;
  /** One sentence explaining the state / why it is greyed. */
  reason: string;
}

export interface FeatureRowStateInput {
  /** In the preloaded (resident) window. */
  resident: boolean;
  /** On screen now via the last-completed feature-index scan. */
  rendered: boolean;
  /** In the current selection (checked). */
  selected: boolean;
  /** A feature-index scan for the current selection is in flight. */
  scanning: boolean;
  /** The element can fetch non-resident features on demand (has a feature index). */
  supportsOnDemandLoad: boolean;
  /** The resident set is known (false → we can't distinguish, treat as shown). */
  residentKnown: boolean;
}

/**
 * Classify a feature's render state from the signals the panel already has.
 * Precedence matters: `resident`/`rendered` (its points are in memory) win over
 * selection/scan state. `rendered` here means "in the loaded matched batch",
 * i.e. in memory — a deselected-but-loaded feature is `cached`, not dropped,
 * because removing a feature filters the in-memory batch rather than re-scanning
 * (re-adding it is instant).
 *
 * This is up for review.
 */
export function describeFeatureRowState({
  resident,
  rendered,
  selected,
  scanning,
  supportsOnDemandLoad,
  residentKnown,
}: FeatureRowStateInput): FeatureRowState {
  if (!residentKnown) {
    return {
      tone: 'loaded',
      greyed: false,
      label: 'shown',
      reason: 'The resident set is unknown for this element, so every feature is treated as shown.',
    };
  }
  if (resident) {
    return {
      tone: 'resident',
      greyed: false,
      label: 'resident',
      reason:
        'In the preloaded window — shown by filtering the in-memory batch (no dataset scan; a large batch can still take a moment to re-filter).',
    };
  }
  if (rendered) {
    return selected
      ? {
          tone: 'loaded',
          greyed: false,
          label: 'loaded',
          reason: 'On screen via the feature-index scan for the current selection.',
        }
      : {
          tone: 'cached',
          greyed: false,
          label: 'in memory',
          reason:
            'Loaded in the matched batch but hidden (deselected); re-adding it is instant, no scan.',
        };
  }
  if (selected && scanning) {
    return {
      tone: 'loading',
      greyed: true,
      label: 'loading',
      reason: 'Selected — its feature-index scan is in progress.',
    };
  }
  if (!supportsOnDemandLoad) {
    return {
      tone: 'noIndex',
      greyed: true,
      label: 'not in sample',
      reason:
        'Beyond the resident window, and this dataset has no feature index, so it can’t be fetched on demand. Raise the memory cap or rewrite the dataset with an index.',
    };
  }
  return {
    tone: 'notLoaded',
    greyed: true,
    label: 'not loaded',
    reason: 'Beyond the resident window; select it to fetch its points via the feature-index scan.',
  };
}

/** Opacity for a row given its state: crisp when its points are on screen,
 * mid-dim while loading, fully dim when not loaded. */
function featureRowOpacity(state: FeatureRowState): number {
  if (!state.greyed) {
    return 1;
  }
  return state.tone === 'loading' ? 0.6 : 0.4;
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
  } = usePointsFeatureState(config.featureCodes);

  const [searchQuery, setSearchQuery] = useState('');
  // Request the full-dataset catalog whenever this panel is shown for a layer.
  // The engine dedupes (no-op once the full scan has settled), so this simply
  // upgrades the instant resident-subset preview to the complete list + counts.
  useEffect(() => {
    requestCatalog();
  }, [requestCatalog]);
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
            >
              <input
                type="checkbox"
                checked={selected}
                onChange={(event) => toggleFeature(entry.code, event.target.checked)}
              />
              <span
                aria-hidden
                style={{ ...swatchStyle, background: featureCodeToCssColor(entry.code) }}
              />
              <span>
                {entry.name}
                {state.greyed ? ' ·' : ''}
              </span>
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
