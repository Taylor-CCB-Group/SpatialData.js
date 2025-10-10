import { useState, useEffect } from 'react';
import { readZarr } from '@spatialdata/core';

const useSpatialData = (url: string) => {
  const [data, setData] = useState();

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
  const [repr, setRepr] = useState('Loading...');
  useEffect(() => {
    if (data && !(data instanceof Error)) {
      data.representation().then(setRepr).catch((error) => {
        console.error('Error getting representation:', error);
        setRepr('Error getting representation');
      });
    } else if (data instanceof Error) {
      setRepr(`Error loading data: ${data.message}`);
    } else {
      setRepr('Loading...');
    }
  }, [data]);

  return (
    <div>
      <h2>Sketching out some functionality</h2>
      
      <h3>SpatialData URL:</h3>
      <input type="text" value={url} onChange={(e) => setUrl(e.target.value)} />
      <h3>String representation:</h3>
      <pre>
        {repr}
      </pre>
      <h3>Full data object:</h3>
      <pre>{JSON.stringify(data, null, 2)}</pre>
    </div>
  );
}
