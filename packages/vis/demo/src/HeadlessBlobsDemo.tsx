import { SpatialDataProvider, useSpatialData } from '@spatialdata/react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  SpatialCanvasViewer,
  type RenderStack,
  type SpatialFeaturePickEvent,
  type ViewState,
} from '../../src/index';
import { buildHeadlessRenderStackForCoordinateSystem } from './buildHeadlessLayers';
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
  // const tables = spatialData?.getAssociatedTables("shapes", "blobs_multipolygons");
  // console.log(tables);

  const [coordinateSystem, setCoordinateSystem] = useState<string | null>(null);
  const [renderStack, setRenderStack] = useState<RenderStack>({ schemaVersion: 1, entries: [] });
  const [viewState, setViewState] = useState<ViewState | null>(null);
  const [lastFeatureHover, setLastFeatureHover] = useState<SpatialFeaturePickEvent | null>(null);

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
    setRenderStack(buildHeadlessRenderStackForCoordinateSystem(spatialData, coordinateSystem));
    setViewState(null);
  }, [spatialData, coordinateSystem]);

  const toggleLayerVisibility = useCallback((layerId: string) => {
    setRenderStack((prev) => ({
      ...prev,
      entries: prev.entries.map((entry) =>
        entry.id === layerId ? { ...entry, visible: !entry.visible } : entry
      ),
    }));
  }, []);

  const statusMessage = useMemo(() => {
    if (loading) return 'Loading blobs fixture…';
    if (error) return `Failed to load fixture: ${error.message}`;
    if (!spatialData) return 'No SpatialData loaded.';
    if (!coordinateSystem) return 'No coordinate system available.';
    if (renderStack.entries.length === 0) return 'No layers in this coordinate system.';
    return null;
  }, [loading, error, spatialData, coordinateSystem, renderStack.entries.length]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      <div style={panelStyle}>
        <div style={{ color: '#888', marginBottom: 6 }}>
          Headless <code>SpatialCanvasViewer</code> — local <code>blobs.zarr</code> (v0.7.2)
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
        {renderStack.entries.length > 0 ? (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
            <span style={{ color: '#999' }}>Layers</span>
            {renderStack.entries.map((entry) => {
              if (entry.kind !== 'spatial') return null;
              return (
                <label key={entry.id} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                  <input
                    type="checkbox"
                    checked={entry.visible}
                    onChange={() => toggleLayerVisibility(entry.id)}
                  />
                  <span>
                    {entry.source.elementType}:{entry.source.elementKey}
                  </span>
                </label>
              );
            })}
          </div>
        ) : null}
        {lastFeatureHover ? (
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
                elementKind: lastFeatureHover.elementKind,
                elementKey: lastFeatureHover.spatialElement.key,
                featureId: lastFeatureHover.featureId,
                rowIndex: lastFeatureHover.rowIndex,
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
                Ensure fixtures exist: <code>pnpm test:fixtures:generate:0.7.2</code>
                <br />
                The dev script also starts a fixture server proxied at <code>/test-fixtures</code>.
              </div>
            ) : null}
          </div>
        ) : (
          <SpatialCanvasViewer
            spatialData={spatialData}
            coordinateSystem={coordinateSystem}
            renderStack={renderStack}
            viewState={viewState}
            onViewStateChange={setViewState}
            renderTooltip={false}
            onFeatureHover={setLastFeatureHover}
            onFeatureClick={(event) => {
              if (event.elementKind !== 'labels') return;
              if (event.spatialElement.key !== 'blobs_labels') return;
              console.log(event.labelId, event.spatialElement);
            }}
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
