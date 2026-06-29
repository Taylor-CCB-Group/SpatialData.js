import { useSpatialData } from '@spatialdata/react';
import JsonView from '@uiw/react-json-view';
import { darkTheme } from '@uiw/react-json-view/dark';
import { useEffect, useMemo, useState } from 'react';
// import type { Table } from "@spatialdata/core";

export default function TableComponent() {
  const { spatialData } = useSpatialData();
  const [selectedTable, setSelectedTable] = useState<string>('');
  const table = useMemo(() => {
    return spatialData?.tables?.[selectedTable];
  }, [selectedTable, spatialData?.tables]);
  // Keep the resolved data tagged with the table it came from so stale data is
  // hidden by deriving during render rather than clearing via setState-in-effect.
  const [tableData, setTableData] = useState<{ table: unknown; data: any } | undefined>(undefined);
  useEffect(() => {
    if (!table) return;
    let cancelled = false;
    table.getAnnDataJS().then((t) => {
      if (!cancelled) setTableData({ table, data: t });
    });
    return () => {
      cancelled = true;
    };
  }, [table]);
  const currentData = tableData && tableData.table === table ? tableData.data : undefined;
  return (
    <div>
      {spatialData?.tables && (
        <select value={selectedTable || ''} onChange={(e) => setSelectedTable(e.target.value)}>
          {Object.keys(spatialData.tables).map((key) => (
            <option key={key} value={key}>
              {key}
            </option>
          ))}
        </select>
      )}
      {currentData && <JsonView value={currentData} style={darkTheme} />}
    </div>
  );
}
