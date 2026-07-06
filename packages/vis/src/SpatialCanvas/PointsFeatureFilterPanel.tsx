import type { CSSProperties } from 'react';
import { useMemo, useState } from 'react';
import type { PointsFeatureCatalog } from '@spatialdata/core';
import type { PointsLayerConfig } from './types';

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
  onRequestCatalog: (layerId: string) => void;
  updateLayer: (id: string, updates: Partial<PointsLayerConfig>) => void;
}

export function PointsFeatureFilterPanel({
  layerId,
  config,
  catalog,
  catalogLoading = false,
  onRequestCatalog,
  updateLayer,
}: PointsFeatureFilterPanelProps) {
  const [searchQuery, setSearchQuery] = useState('');
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
          return (
            <label
              key={entry.code}
              style={checkboxLabelStyle}
              title={`code ${entry.code}${entry.count !== undefined ? ` · ${entry.count.toLocaleString()} points` : ''}`}
            >
              <input
                type="checkbox"
                checked={checked}
                onChange={(event) => toggleFeature(entry.code, event.target.checked)}
              />
              <span>{entry.name}</span>
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
