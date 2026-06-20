import type { CSSProperties } from 'react';
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

export interface PointsFeatureFilterPanelProps {
  layerId: string;
  config: PointsLayerConfig;
  catalog?: PointsFeatureCatalog | null;
  catalogLoading?: boolean;
  updateLayer: (id: string, updates: Partial<PointsLayerConfig>) => void;
}

export function PointsFeatureFilterPanel({
  layerId,
  config,
  catalog,
  catalogLoading = false,
  updateLayer,
}: PointsFeatureFilterPanelProps) {
  const entries = catalog?.entries ?? [];
  const allSelected = config.featureCodes === undefined;
  const noneSelected = config.featureCodes !== undefined && config.featureCodes.length === 0;
  const selectedCodes = allSelected ? new Set(entries.map((entry) => entry.code)) : new Set(config.featureCodes ?? []);

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

  if (!catalog || entries.length === 0) {
    return (
      <div style={panelStyle}>
        <div style={helperStyle}>No feature catalog available for this points layer.</div>
      </div>
    );
  }

  const selectedCount = noneSelected ? 0 : allSelected ? entries.length : selectedCodes.size;

  return (
    <div style={panelStyle}>
      <div>
        Features ({catalog.featureKey})
        <span style={helperStyle}>
          {' '}
          · {selectedCount}/{entries.length} selected
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
      <div style={listStyle}>
        {entries.map((entry) => {
          const checked = !noneSelected && (allSelected || selectedCodes.has(entry.code));
          return (
            <label key={entry.code} style={checkboxLabelStyle} title={`code ${entry.code}`}>
              <input
                type="checkbox"
                checked={checked}
                onChange={(event) => toggleFeature(entry.code, event.target.checked)}
              />
              {entry.name}
            </label>
          );
        })}
      </div>
    </div>
  );
}
