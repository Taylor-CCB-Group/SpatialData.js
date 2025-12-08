import { useSpatialData } from "@spatialdata/react";
import JsonView from "@uiw/react-json-view";
import { darkTheme } from "@uiw/react-json-view/dark";
import { useEffect, useMemo, useState } from "react";
// import type { Table } from "@spatialdata/core";

export default function ShapesComponent() {
  const { spatialData } = useSpatialData();
  const [selectedShapes, setSelectedShapes] = useState<string>('');
  const shapeKeys = useMemo(() => Object.keys(spatialData?.shapes ?? {}), [spatialData?.shapes]);
  
  // Default to first available shape
  useEffect(() => {
    if (shapeKeys.length > 0 && !selectedShapes) {
      setSelectedShapes(shapeKeys[0]);
    }
  }, [shapeKeys, selectedShapes]);

  const shapes = useMemo(() => {
    return spatialData?.shapes?.[selectedShapes];
  }, [selectedShapes, spatialData?.shapes]);
  const [shapesData, setShapesData] = useState<any>(undefined);
  useEffect(() => {
    if (shapes) {
      const result = shapes.getTransformation();
      if (result.ok) {
        const t = result.value;
        setShapesData({
          type: t.type,
          input: t.input,
          output: t.output,
          matrix: t.toArray(),
        });
      } else {
        // Show the error info
        setShapesData({
          error: result.error.message,
          availableCoordinateSystems: result.error.availableCoordinateSystems,
        });
      }
    } else {
      setShapesData(undefined);
    }
  }, [shapes]);
  return (
    <div>
      <h3>Shapes component:</h3>
      {spatialData?.shapes &&
        <select value={selectedShapes || ''} onChange={(e) => setSelectedShapes(e.target.value)}>
          {Object.keys(spatialData.shapes).map((key) => (
            <option key={key} value={key}>{key}</option>
          ))}
        </select>
      }
      {shapesData && <JsonView value={shapesData} style={darkTheme} collapsed />}
    </div>
  )
}