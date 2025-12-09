import { useSpatialData } from "@spatialdata/react";
import JsonView from "@uiw/react-json-view";
import { darkTheme } from "@uiw/react-json-view/dark";
import { useEffect, useMemo, useState } from "react";
import type { SpatialElement } from "@spatialdata/core";

const SPATIAL_ELEMENT_TYPES = ['images', 'labels', 'shapes', 'points'] as const;
type SpatialElementType = typeof SPATIAL_ELEMENT_TYPES[number];

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
  
  // Find currently selected element
  const selectedEntry = useMemo(() => {
    return allElements.find(e => getElementId(e) === selectedElementId);
  }, [allElements, selectedElementId]);
  
  // Get coordinate systems for selected element
  const coordinateSystems = useMemo(() => {
    if (!selectedEntry) return [];
    return selectedEntry.element.coordinateSystems;
  }, [selectedEntry]);
  
  // Default to first element when data loads or changes
  useEffect(() => {
    if (allElements.length > 0 && (!selectedElementId || !allElements.find(e => getElementId(e) === selectedElementId))) {
      setSelectedElementId(getElementId(allElements[0]));
    }
  }, [allElements, selectedElementId]);
  
  // Default to first coordinate system when element changes
  useEffect(() => {
    if (coordinateSystems.length > 0 && (!selectedCS || !coordinateSystems.includes(selectedCS))) {
      setSelectedCS(coordinateSystems[0]);
    } else if (coordinateSystems.length === 0) {
      setSelectedCS('');
    }
  }, [coordinateSystems, selectedCS]);
  
  // Get transformation result
  const transformData = useMemo(() => {
    if (!selectedEntry || !selectedCS) return null;
    
    const result = selectedEntry.element.getTransformation(selectedCS);
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
  }, [selectedEntry, selectedCS]);
  
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
            value={selectedElementId} 
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
            value={selectedCS} 
            onChange={(e) => setSelectedCS(e.target.value)}
            disabled={coordinateSystems.length === 0}
            style={{ minWidth: '150px' }}
          >
            {coordinateSystems.length === 0 && <option value="">No transforms</option>}
            {coordinateSystems.map((cs) => (
              <option key={cs} value={cs}>{cs}</option>
            ))}
          </select>
        </label>
      </div>
      
      {transformData && (
        <JsonView value={transformData} style={darkTheme} collapsed={false} />
      )}
    </div>
  );
}

