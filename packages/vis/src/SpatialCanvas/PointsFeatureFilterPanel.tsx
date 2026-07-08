import type { CSSProperties } from 'react';
import { useEffect, useMemo, useState } from 'react';
import type { PointsFeatureCatalog } from '@spatialdata/core';
import type { PointsMatchingLoadState } from '@spatialdata/layers';
import { featureCodeToCssColor } from '@spatialdata/layers';
import type { PointsLayerConfig } from './types';

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

export interface PointsFeatureFilterPanelProps {
  layerId: string;
  config: PointsLayerConfig;
  catalog?: PointsFeatureCatalog | null;
  catalogLoading?: boolean;
  /** The full-dataset catalog scan is still refining the instant preview. */
  catalogRefining?: boolean;
  /** Feature codes present in the loaded (resident) batch. Features outside this
   * set are in the catalog but not in the instant preview, so selecting them
   * triggers an on-demand feature-index scan. `undefined` disables the
   * distinction (treat every feature as resident). */
  residentCodes?: ReadonlySet<number>;
  /** Non-resident feature codes currently on screen (the last-completed matched
   * selection). Features here are "loaded" regardless of whether a newer scan is
   * still running, so adding a feature doesn't grey the already-loaded ones. */
  loadedMatchingCodes?: ReadonlySet<number>;
  /** Whether selecting a non-resident (greyed) feature fetches its points on
   * demand via the feature-index scan. False for dictionary-only datasets, whose
   * greyed features simply aren't in the loaded preview window and can't be shown
   * until the cap is raised or the dataset is written with a feature index. */
  supportsOnDemandLoad?: boolean;
  /** Progressive load state of the feature-index scan for the current selection. */
  matchingLoadState?: PointsMatchingLoadState;
  onRequestCatalog: (layerId: string) => void;
  updateLayer: (id: string, updates: Partial<PointsLayerConfig>) => void;
}

export function PointsFeatureFilterPanel({
  layerId,
  config,
  catalog,
  catalogLoading = false,
  catalogRefining = false,
  residentCodes,
  loadedMatchingCodes,
  supportsOnDemandLoad = true,
  matchingLoadState,
  onRequestCatalog,
  updateLayer,
}: PointsFeatureFilterPanelProps) {
  const [searchQuery, setSearchQuery] = useState('');
  // Request the full-dataset catalog whenever this panel is shown for a layer.
  // The engine dedupes (no-op once the full scan has settled), so this simply
  // upgrades the instant resident-subset preview to the complete list + counts.
  useEffect(() => {
    onRequestCatalog(layerId);
  }, [layerId, onRequestCatalog]);
  const entries = catalog?.entries ?? [];
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
        <button type="button" style={buttonStyle} onClick={() => onRequestCatalog(layerId)}>
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
  const isLoaded = (code: number): boolean =>
    !residentKnown || residentCodes.has(code) || (loadedMatchingCodes?.has(code) ?? false);
  const notLoadedCount = residentKnown
    ? entries.reduce((total, entry) => total + (isLoaded(entry.code) ? 0 : 1), 0)
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
      {catalogRefining ? (
        <div style={helperStyle}>Loading the full feature list…</div>
      ) : null}
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
          const checked = !noneSelected && (allSelected || selectedCodes.has(entry.code));
          const notLoaded = !isLoaded(entry.code);
          return (
            <label
              key={entry.code}
              style={notLoaded ? { ...checkboxLabelStyle, opacity: 0.45 } : checkboxLabelStyle}
              title={
                `code ${entry.code}` +
                (entry.count !== undefined ? ` · ${entry.count.toLocaleString()} points` : '') +
                (notLoaded
                  ? supportsOnDemandLoad
                    ? ' · not loaded (select to load its points)'
                    : ' · not in the loaded sample'
                  : '')
              }
            >
              <input
                type="checkbox"
                checked={checked}
                onChange={(event) => toggleFeature(entry.code, event.target.checked)}
              />
              <span
                aria-hidden
                style={{ ...swatchStyle, background: featureCodeToCssColor(entry.code) }}
              />
              <span>
                {entry.name}
                {notLoaded ? ' ·' : ''}
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
