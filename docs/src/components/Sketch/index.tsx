import { useState, useEffect } from 'react';
import { readZarr } from '@spatialdata/core';

const useSpatialData = (url: string) => {
  const [data, setData] = useState([]);

  useEffect(() => {
    readZarr(url).then(setData).catch((error) => {
      console.error('Error loading spatial data:', error);
      setData(error);
    });
  }, [url]);

  return data;
};
const defaultUrl = 'https://storage.googleapis.com/vitessce-demo-data/spatialdata-august-2025/visium_hd_3.0.0.spatialdata.zarr';

export default function Sketch() {
  const [url, setUrl] = useState(defaultUrl);
  const data = useSpatialData(url);
  return (
    <div>
      <h2>Sketching out some functionality</h2>
      <input type="text" value={url} onChange={(e) => setUrl(e.target.value)} />
      <pre>{JSON.stringify(data, null, 2)}</pre>
    </div>
  );
}
