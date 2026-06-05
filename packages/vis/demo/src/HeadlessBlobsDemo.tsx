import { SpatialDataProvider, useSpatialData } from '@spatialdata/react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { SpatialCanvasViewer, type LayerConfig, type ViewState } from '../../src/index';
import type { ShapesLayerPickEvent } from '../../src/SpatialCanvas/types';
import { buildHeadlessLayersForCoordinateSystem } from './buildHeadlessLayers';
import { getLocalBlobsFixtureUrl } from './fixtureUrls';

const panelStyle = {
  flexShrink: 0,
  padding: '10px 12px',
  borderBottom: '1px solid #333',
  background: '#1e1e1e',
  fontSize: 12,
} as const;

const viewerShellStyle = {
  flex: 1,
  minHeight: 0,
  position: 'relative' as const,
};

function HeadlessBlobsViewer({ fixtureUrl }: { fixtureUrl: string }) {
  const { spatialData, loading, error } = useSpatialData();
  const coordinateSystems = useMemo(() => spatialData?.coordinateSystems ?? [], [spatialData]);
  const tables = spatialData?.getAssociatedTables("shapes", "blobs_multipolygons");
  console.log(tables);

  const [coordinateSystem, setCoordinateSystem] = useState<string | null>(null);
  const [layers, setLayers] = useState<Record<string, LayerConfig>>({});
  const [layerOrder, setLayerOrder] = useState<string[]>([]);
  const [viewState, setViewState] = useState<ViewState | null>(null);
  const [lastShapeHover, setLastShapeHover] = useState<ShapesLayerPickEvent | null>(null);

  useEffect(() => {
    if (!spatialData || coordinateSystems.length === 0) {
      return;
    }
    setCoordinateSystem((prev) => prev ?? coordinateSystems[0] ?? null);
  }, [spatialData, coordinateSystems]);

  useEffect(() => {
    if (!spatialData || !coordinateSystem) {
      return;
    }
    const built = buildHeadlessLayersForCoordinateSystem(spatialData, coordinateSystem);
    setLayers(built.layers);
    setLayerOrder(built.layerOrder);
    setViewState(null);
  }, [spatialData, coordinateSystem]);

  const toggleLayerVisibility = useCallback((layerId: string) => {
    setLayers((prev) => {
      const existing = prev[layerId];
      if (!existing) return prev;
      return { ...prev, [layerId]: { ...existing, visible: !existing.visible } };
    });
  }, []);

  const statusMessage = useMemo(() => {
    if (loading) return 'Loading blobs fixture…';
    if (error) return `Failed to load fixture: ${error.message}`;
    if (!spatialData) return 'No SpatialData loaded.';
    if (!coordinateSystem) return 'No coordinate system available.';
    if (layerOrder.length === 0) return 'No layers in this coordinate system.';
    return null;
  }, [loading, error, spatialData, coordinateSystem, layerOrder.length]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      <div style={panelStyle}>
        <div style={{ color: '#888', marginBottom: 6 }}>
          Headless <code>SpatialCanvasViewer</code> — local{' '}
          <code>blobs.zarr</code> (v0.7.2)
        </div>
        <div style={{ marginBottom: 8, wordBreak: 'break-all' }}>
          <span style={{ color: '#666' }}>Fixture: </span>
          <a href={fixtureUrl} style={{ color: '#8af' }}>
            {fixtureUrl}
          </a>
        </div>
        {coordinateSystems.length > 1 ? (
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
            <span style={{ color: '#999' }}>Coordinate system</span>
            <select
              value={coordinateSystem ?? ''}
              onChange={(e) => setCoordinateSystem(e.target.value || null)}
            >
              {coordinateSystems.map((cs) => (
                <option key={cs} value={cs}>
                  {cs}
                </option>
              ))}
            </select>
          </label>
        ) : (
          <div style={{ marginBottom: 8, color: '#aaa' }}>
            Coordinate system: <code>{coordinateSystem ?? '—'}</code>
          </div>
        )}
        {layerOrder.length > 0 ? (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
            <span style={{ color: '#999' }}>Layers</span>
            {layerOrder.map((layerId) => {
              const config = layers[layerId];
              if (!config) return null;
              return (
                <label key={layerId} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                  <input
                    type="checkbox"
                    checked={config.visible}
                    onChange={() => toggleLayerVisibility(layerId)}
                  />
                  <span>
                    {config.type}:{config.elementKey}
                  </span>
                </label>
              );
            })}
          </div>
        ) : null}
        {lastShapeHover ? (
          <pre
            style={{
              marginTop: 8,
              marginBottom: 0,
              padding: 8,
              background: '#111',
              borderRadius: 4,
              fontSize: 11,
              overflow: 'auto',
            }}
          >
            {JSON.stringify(
              {
                featureId: lastShapeHover.featureId,
                featureIndex: lastShapeHover.featureIndex,
                rowIndex: lastShapeHover.rowIndex,
              },
              null,
              2
            )}
          </pre>
        ) : null}
      </div>

      <div style={viewerShellStyle}>
        {statusMessage ? (
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              height: '100%',
              color: '#888',
              padding: 16,
              textAlign: 'center',
            }}
          >
            {statusMessage}
            {error ? (
              <div style={{ marginTop: 12, fontSize: 11, color: '#a88' }}>
                Ensure fixtures exist:{' '}
                <code>pnpm test:fixtures:generate:0.7.2</code>
                <br />
                The dev script also starts a fixture server proxied at{' '}
                <code>/test-fixtures</code>.
              </div>
            ) : null}
          </div>
        ) : (
          <SpatialCanvasViewer
            spatialData={spatialData}
            coordinateSystem={coordinateSystem}
            layers={layers}
            layerOrder={layerOrder}
            viewState={viewState}
            onViewStateChange={setViewState}
            renderTooltip={false}
            onShapeHover={setLastShapeHover}
            style={{ width: '100%', height: '100%' }}
          />
        )}
      </div>
    </div>
  );
}

export default function HeadlessBlobsDemo() {
  const fixtureUrl = useMemo(() => getLocalBlobsFixtureUrl(), []);

  return (
    <SpatialDataProvider source={fixtureUrl}>
      <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
        <HeadlessBlobsViewer fixtureUrl={fixtureUrl} />
      </div>
    </SpatialDataProvider>
  );
}
