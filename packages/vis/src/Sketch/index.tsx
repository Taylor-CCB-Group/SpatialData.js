import { useState } from 'react';
import { SpatialDataProvider } from '@spatialdata/react';
import SpatialDataTree from '../Tree';
import Table from '../Table';
import ImageView from '../ImageView';


const defaultUrl = 'https://storage.googleapis.com/vitessce-demo-data/spatialdata-august-2025/visium_hd_3.0.0.spatialdata.zarr';

function DataSource({children}: React.PropsWithChildren) {
  const [url, setUrl] = useState(defaultUrl);
  return (
    <div>
      <h3>SpatialData URL:</h3>
      <input type="text" value={url} onChange={(e) => setUrl(e.target.value)} />
      <SpatialDataProvider storeUrl={url}>
        {children}
      </SpatialDataProvider>
    </div>
  )
}

export default function App() {
  return (
    <DataSource>
      <Sketch />
    </DataSource>
  )
}

function Sketch() {
  // const { spatialData, loading, error } = useSpatialData();

  return (
    <div>
      <h2>Sketching out some functionality</h2>
      
      <SpatialDataTree />
      <Table />
      <ImageView />
    </div>
  );
}
