import { useSpatialData } from "@spatialdata/react";
import JsonView from "@uiw/react-json-view";
import { darkTheme } from "@uiw/react-json-view/dark";
import { useEffect, useMemo, useState } from "react";
// import type { Table } from "@spatialdata/core";

export default function TableComponent() {
  const { spatialData } = useSpatialData();
  const [selectedTable, setSelectedTable] = useState<string>('');
  const table = useMemo(() => {
    return spatialData?.tables?.[selectedTable];
  }, [selectedTable, spatialData?.tables]);
  const [tableData, setTableData] = useState<any>(undefined);
  useEffect(() => {
    if (table) {
      table().then(t => setTableData(t));
    } else {
      setTableData(undefined);
    }
  }, [table]);
  return (
    <div>
      {spatialData?.tables && 
        <select value={selectedTable || ''} onChange={(e) => setSelectedTable(e.target.value)}>
          {Object.keys(spatialData.tables).map((key) => (
            <option key={key} value={key}>{key}</option>
          ))}
        </select>
      }
      {tableData && <JsonView value={tableData} style={darkTheme} />}
    </div>
  )
}