import { SpatialDataProvider, useSpatialData } from '@spatialdata/react';
import { useEffect, useMemo, useState } from 'react';
import { type LayerConfig, SpatialCanvasViewer, type ViewState } from '../../src/index';
import { buildHeadlessLayersForCoordinateSystem } from './buildHeadlessLayers';
import {
  getLocalHtj2kCodecFixtureUrl,
  getLocalHtj2kCodecManifestUrl,
  getLocalJpeg2kCodecFixtureUrl,
  getLocalJpeg2kCodecManifestUrl,
} from './fixtureUrls';

type CodecFixtureKind = 'jpeg2k' | 'htj2k';

const FIXTURE_CONFIG: Record<
  CodecFixtureKind,
  {
    label: string;
    storeName: string;
    getFixtureUrl: (origin?: string) => string;
    getManifestUrl: (origin?: string) => string;
  }
> = {
  jpeg2k: {
    label: 'JP2K',
    storeName: 'jpeg2k.zarr',
    getFixtureUrl: getLocalJpeg2kCodecFixtureUrl,
    getManifestUrl: getLocalJpeg2kCodecManifestUrl,
  },
  htj2k: {
    label: 'HTJ2K (experimental.openjph_htj2k)',
    storeName: 'htj2k.zarr',
    getFixtureUrl: getLocalHtj2kCodecFixtureUrl,
    getManifestUrl: getLocalHtj2kCodecManifestUrl,
  },
};

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

function CodecFixtureViewer({
  fixtureKind,
  fixtureUrl,
  manifestUrl,
}: {
  fixtureKind: CodecFixtureKind;
  fixtureUrl: string;
  manifestUrl: string;
}) {
  const fixtureConfig = FIXTURE_CONFIG[fixtureKind];
  const { spatialData, loading, error } = useSpatialData();
  const coordinateSystems = useMemo(() => spatialData?.coordinateSystems ?? [], [spatialData]);
  const [coordinateSystem, setCoordinateSystem] = useState<string | null>(null);
  const [layers, setLayers] = useState<Record<string, LayerConfig>>({});
  const [layerOrder, setLayerOrder] = useState<string[]>([]);
  const [viewState, setViewState] = useState<ViewState | null>(null);

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

  const statusMessage = useMemo(() => {
    if (loading) return `Loading ${fixtureConfig.label} codec fixture...`;
    if (error) return `Failed to load ${fixtureConfig.label} fixture: ${error.message}`;
    if (!spatialData) return 'No SpatialData loaded.';
    if (!coordinateSystem) return 'No coordinate system available.';
    if (layerOrder.length === 0) return 'No layers in this coordinate system.';
    return null;
  }, [loading, error, spatialData, coordinateSystem, layerOrder.length, fixtureConfig.label]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      <div style={panelStyle}>
        <div style={{ color: '#888', marginBottom: 6 }}>
          Codec fixture <code>SpatialCanvasViewer</code> - local <code>{fixtureConfig.storeName}</code>
        </div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, marginBottom: 8 }}>
          <a href={fixtureUrl} style={{ color: '#8af' }}>
            Store
          </a>
          <a href={manifestUrl} style={{ color: '#8af' }}>
            Manifest
          </a>
          <span style={{ color: '#aaa' }}>
            Codec: <code>{fixtureConfig.label}</code>
          </span>
          <span style={{ color: '#aaa' }}>
            Coordinate system: <code>{coordinateSystem ?? '-'}</code>
          </span>
          <span style={{ color: '#aaa' }}>
            Layers: <code>{layerOrder.length}</code>
          </span>
        </div>
        {error ? (
          <div style={{ color: '#d99' }}>
            Generate fixtures with <code>pnpm test:fixtures:generate:codecs</code>.
          </div>
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
            style={{ width: '100%', height: '100%' }}
          />
        )}
      </div>
    </div>
  );
}

export default function CodecFixtureDemo() {
  const [fixtureKind, setFixtureKind] = useState<CodecFixtureKind>('jpeg2k');
  const fixtureConfig = FIXTURE_CONFIG[fixtureKind];
  const fixtureUrl = useMemo(() => fixtureConfig.getFixtureUrl(), [fixtureConfig]);
  const manifestUrl = useMemo(() => fixtureConfig.getManifestUrl(), [fixtureConfig]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      <div style={panelStyle}>
        <label style={{ display: 'inline-flex', alignItems: 'center', gap: 8, color: '#ccc' }}>
          Codec fixture
          <select
            value={fixtureKind}
            onChange={(event) => setFixtureKind(event.target.value as CodecFixtureKind)}
            style={{
              background: '#2a2a2a',
              color: '#eee',
              border: '1px solid #444',
              borderRadius: 4,
              padding: '4px 8px',
            }}
          >
            <option value="jpeg2k">JP2K (imagecodecs_jpeg2k)</option>
            <option value="htj2k">HTJ2K (experimental.openjph_htj2k)</option>
          </select>
        </label>
      </div>
      <SpatialDataProvider key={fixtureKind} source={fixtureUrl}>
        <CodecFixtureViewer
          fixtureKind={fixtureKind}
          fixtureUrl={fixtureUrl}
          manifestUrl={manifestUrl}
        />
      </SpatialDataProvider>
    </div>
  );
}
