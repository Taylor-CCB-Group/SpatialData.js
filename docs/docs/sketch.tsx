import { useState, useEffect } from 'react';
import { openSpatialDataStore } from '@spatialdata/core';

const useSpatialData = () => {
  const [data, setData] = useState([]);

  useEffect(() => {
    const baseUrl = 'https://storage.googleapis.com/vitessce-demo-data/spatialdata-august-2025/visium_hd_3.0.0.spatialdata.zarr';
    openSpatialDataStore(baseUrl).then(setData).catch((error) => {
      console.error('Error loading spatial data:', error);
      setData(error);
    });
  }, []);

  return data;
};

export default function Sketch() {
  const data = useSpatialData();
  return (
    <div>
      <h2>Sketching out some functionality</h2>
      <pre>{JSON.stringify(data, null, 2)}</pre>
    </div>
  );
}
