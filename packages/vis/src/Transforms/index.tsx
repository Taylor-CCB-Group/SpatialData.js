import type { SpatialElement } from '@spatialdata/core';
import { useSpatialData } from '@spatialdata/react';
import JsonView from '@uiw/react-json-view';
import { darkTheme } from '@uiw/react-json-view/dark';
import { useMemo, useState } from 'react';

const SPATIAL_ELEMENT_TYPES = ['images', 'labels', 'shapes', 'points'] as const;
type SpatialElementType = (typeof SPATIAL_ELEMENT_TYPES)[number];

type ElementEntry = {
  type: SpatialElementType;
  key: string;
  element: SpatialElement;
};

// Get element ID for dropdown (type/key)
const getElementId = (entry: ElementEntry) => `${entry.type}/${entry.key}`;

/**
 * Debug component for viewing transforms from spatial elements into available coordinate systems
 */
export default function TransformsComponent() {
  const { spatialData, loading, error } = useSpatialData();
  const [selectedElementId, setSelectedElementId] = useState<string>('');
  const [selectedCS, setSelectedCS] = useState<string>('');

  // Gather all spatial elements into a flat list
  const allElements = useMemo(() => {
    if (!spatialData) return [];
    const entries: ElementEntry[] = [];

    for (const type of SPATIAL_ELEMENT_TYPES) {
      const elementsOfType = spatialData[type];
      if (elementsOfType) {
        for (const [key, element] of Object.entries(elementsOfType)) {
          entries.push({ type, key, element: element as SpatialElement });
        }
      }
    }
    return entries;
  }, [spatialData]);

  // Default to the first element when the user hasn't picked one (or their pick
  // is no longer available). Derived during render instead of synced via effect.
  const effectiveElementId = useMemo(() => {
    if (selectedElementId && allElements.some((e) => getElementId(e) === selectedElementId)) {
      return selectedElementId;
    }
    return allElements[0] ? getElementId(allElements[0]) : '';
  }, [allElements, selectedElementId]);

  // Find currently selected element
  const selectedEntry = useMemo(() => {
    return allElements.find((e) => getElementId(e) === effectiveElementId);
  }, [allElements, effectiveElementId]);

  // Get coordinate systems for selected element
  const coordinateSystems = useMemo(() => {
    if (!selectedEntry) return [];
    return selectedEntry.element.coordinateSystems;
  }, [selectedEntry]);

  // Default to the first coordinate system, derived the same way.
  const effectiveCS = useMemo(() => {
    if (selectedCS && coordinateSystems.includes(selectedCS)) return selectedCS;
    return coordinateSystems[0] ?? '';
  }, [coordinateSystems, selectedCS]);

  // Get transformation result
  const transformData = useMemo(() => {
    if (!selectedEntry || !effectiveCS) return null;

    const result = selectedEntry.element.getTransformation(effectiveCS);
    if (result.ok) {
      const t = result.value;
      return {
        status: 'success',
        type: t.type,
        input: t.input,
        output: t.output,
        matrix: t.toArray(),
      };
    }
    return {
      status: 'error',
      error: result.error.message,
      availableCoordinateSystems: result.error.availableCoordinateSystems,
    };
  }, [selectedEntry, effectiveCS]);

  if (loading) return <div>Loading...</div>;
  if (error) return <div>Error: {error.message}</div>;
  if (!spatialData) return <div>No spatial data</div>;

  return (
    <div>
      <h3>Coordinate Transformations</h3>

      <div style={{ display: 'flex', gap: '1rem', marginBottom: '1rem', flexWrap: 'wrap' }}>
        <label style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
          <span>Element:</span>
          <select
            value={effectiveElementId}
            onChange={(e) => setSelectedElementId(e.target.value)}
            style={{ minWidth: '200px' }}
          >
            {allElements.length === 0 && <option value="">No spatial elements</option>}
            {allElements.map((entry) => {
              const id = getElementId(entry);
              return (
                <option key={id} value={id}>
                  {entry.type}/{entry.key}
                </option>
              );
            })}
          </select>
        </label>

        <label style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
          <span>Coordinate System:</span>
          <select
            value={effectiveCS}
            onChange={(e) => setSelectedCS(e.target.value)}
            disabled={coordinateSystems.length === 0}
            style={{ minWidth: '150px' }}
          >
            {coordinateSystems.length === 0 && <option value="">No transforms</option>}
            {coordinateSystems.map((cs) => (
              <option key={cs} value={cs}>
                {cs}
              </option>
            ))}
          </select>
        </label>
      </div>

      {transformData && <JsonView value={transformData} style={darkTheme} collapsed={false} />}
    </div>
  );
}
