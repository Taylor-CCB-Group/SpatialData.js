import { useState } from 'react';
import { SpatialDataProvider, useSpatialData } from '@spatialdata/react';
import SpatialDataTree from '../Tree';
import Table from '../Table';
import ImageView from '../ImageView';
import Transforms from '../Transforms';
import SpatialCanvas from '../SpatialCanvas';


const defaultUrl =
  'https://storage.googleapis.com/vitessce-demo-data/spatialdata-august-2025/visium_hd_3.0.0.spatialdata.zarr';

function DataSource({ children }: React.PropsWithChildren) {
  const [url, setUrl] = useState(defaultUrl);
  return (
    <div>
      <h3>SpatialData URL:</h3>
      <input
        type="text"
        value={url}
        onChange={(e) => setUrl(e.target.value)}
        style={{ width: '100%' }}
      />
      <SpatialDataProvider storeUrl={url}>{children}</SpatialDataProvider>
    </div>
  );
}

function Repr() {
  const { spatialData } = useSpatialData();
  return (
    <pre style={{maxWidth: '90vw'}}>
      {spatialData?.toString()}
    </pre>
  )
}

export default function Sketch() {
  // const { spatialData, loading, error } = useSpatialData();

  return (
    <DataSource>
      <Repr />
      
      <h3>SpatialCanvas</h3>
      <div style={{ height: '500px', marginBottom: '20px' }}>
        <SpatialCanvas />
      </div>

      <SpatialDataTree />
      <Table />
      <Transforms />
      <ImageView />
    </DataSource>
  );
}
