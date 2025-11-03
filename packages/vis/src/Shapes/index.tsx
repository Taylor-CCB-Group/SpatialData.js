import { useSpatialData } from "@spatialdata/react";
import JsonView from "@uiw/react-json-view";
import { darkTheme } from "@uiw/react-json-view/dark";
import { useEffect, useMemo, useState } from "react";
// import type { Table } from "@spatialdata/core";

export default function ShapesComponent() {
  const { spatialData } = useSpatialData();
  const [selectedShapes, setSelectedShapes] = useState<string>('');
  const table = useMemo(() => {
    return spatialData?.shapes?.[selectedShapes];
  }, [selectedShapes, spatialData?.shapes]);
  const [shapesData, setShapesData] = useState<any>(undefined);
  useEffect(() => {
    if (table) {
      table().then(t => setShapesData(t));
    } else {
      setShapesData(undefined);
    }
  }, [table]);
  return (
    <div>
      {spatialData?.shapes &&
        <select value={selectedShapes || ''} onChange={(e) => setSelectedShapes(e.target.value)}>
          {Object.keys(spatialData.shapes).map((key) => (
            <option key={key} value={key}>{key}</option>
          ))}
        </select>
      }
      {shapesData && <JsonView value={shapesData} style={darkTheme} />}
    </div>
  )
}