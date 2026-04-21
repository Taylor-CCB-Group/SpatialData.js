import { useState, type CSSProperties } from 'react';
import { SpatialDataProvider, useSpatialData } from '@spatialdata/react';
import SpatialDataTree from '../Tree';
import Table from '../Table';
import ImageView from '../ImageView';
import Transforms from '../Transforms';
import SpatialCanvas from '../SpatialCanvas';

const defaultUrl =
  'https://storage.googleapis.com/vitessce-demo-data/spatialdata-august-2025/visium_hd_3.0.0.spatialdata.zarr';

const dataSourceBarStyle: CSSProperties = {
  flexShrink: 0,
  padding: '8px 12px',
  borderBottom: '1px solid #333',
  background: '#1e1e1e',
};

function DataSource({ children }: React.PropsWithChildren) {
  const [url, setUrl] = useState(defaultUrl);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      <div style={dataSourceBarStyle}>
        <div style={{ fontSize: 12, color: '#888', marginBottom: 4 }}>SpatialData URL</div>
        <input
          type="text"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          style={{ width: '100%', boxSizing: 'border-box', padding: '6px 8px' }}
        />
      </div>
      <div style={{ flex: 1, minHeight: 0, overflow: 'auto' }}>
        <SpatialDataProvider source={url}>{children}</SpatialDataProvider>
      </div>
    </div>
  );
}

function Repr() {
  const { spatialData } = useSpatialData();
  return <pre style={{ maxWidth: '90vw' }}>{spatialData?.toString()}</pre>;
}

export default function Sketch() {
  return (
    <DataSource>
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: 16,
          padding: 12,
          minHeight: '100%',
        }}
      >
        <Repr />

        <section style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 360 }}>
          <h3 style={{ margin: '0 0 8px', fontSize: 14 }}>SpatialCanvas</h3>
          <div style={{ flex: 1, minHeight: 0 }}>
            <SpatialCanvas />
          </div>
        </section>

        <SpatialDataTree />
        <Table />
        <Transforms />
        <ImageView />
      </div>
    </DataSource>
  );
}
