import { useSpatialData } from '@spatialdata/react';
import JsonView from '@uiw/react-json-view';
import { darkTheme } from '@uiw/react-json-view/dark';
import { useMemo, useState } from 'react';
// import type { Table } from "@spatialdata/core";

export default function ShapesComponent() {
  const { spatialData } = useSpatialData();
  const [selectedShapes, setSelectedShapes] = useState<string>('');
  const shapeKeys = useMemo(() => Object.keys(spatialData?.shapes ?? {}), [spatialData?.shapes]);

  // Default to the first available shape, derived during render.
  const effectiveShapes =
    selectedShapes && shapeKeys.includes(selectedShapes) ? selectedShapes : (shapeKeys[0] ?? '');

  const shapes = useMemo(() => {
    return spatialData?.shapes?.[effectiveShapes];
  }, [effectiveShapes, spatialData?.shapes]);

  // getTransformation() is synchronous, so the displayed data is pure derived
  // state rather than something to sync into an effect.
  const shapesData = useMemo(() => {
    if (!shapes) return undefined;
    const result = shapes.getTransformation();
    if (result.ok) {
      const t = result.value;
      return {
        type: t.type,
        input: t.input,
        output: t.output,
        matrix: t.toArray(),
      };
    }
    // Show the error info
    return {
      error: result.error.message,
      availableCoordinateSystems: result.error.availableCoordinateSystems,
    };
  }, [shapes]);
  return (
    <div>
      <h3>Shapes component:</h3>
      {spatialData?.shapes && (
        <select value={effectiveShapes} onChange={(e) => setSelectedShapes(e.target.value)}>
          {Object.keys(spatialData.shapes).map((key) => (
            <option key={key} value={key}>
              {key}
            </option>
          ))}
        </select>
      )}
      {shapesData && <JsonView value={shapesData} style={darkTheme} collapsed />}
    </div>
  );
}
