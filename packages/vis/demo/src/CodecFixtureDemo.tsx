import OpenJPEGJS from '@cornerstonejs/codec-openjpeg/decode';
import { SpatialDataProvider, useSpatialData } from '@spatialdata/react';
import { useEffect, useMemo, useState } from 'react';
import { createOpenJpegDecoder, registerJpeg2kCodec } from 'zarrextra';
import { type LayerConfig, SpatialCanvasViewer, type ViewState } from '../../src/index';
import { buildHeadlessLayersForCoordinateSystem } from './buildHeadlessLayers';
import { getLocalJpeg2kCodecFixtureUrl, getLocalJpeg2kCodecManifestUrl } from './fixtureUrls';

registerJpeg2kCodec({ decoder: createOpenJpegDecoder(OpenJPEGJS) });

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
  fixtureUrl,
  manifestUrl,
}: {
  fixtureUrl: string;
  manifestUrl: string;
}) {
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
    if (loading) return 'Loading JP2K codec fixture...';
    if (error) return `Failed to load JP2K fixture: ${error.message}`;
    if (!spatialData) return 'No SpatialData loaded.';
    if (!coordinateSystem) return 'No coordinate system available.';
    if (layerOrder.length === 0) return 'No layers in this coordinate system.';
    return null;
  }, [loading, error, spatialData, coordinateSystem, layerOrder.length]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      <div style={panelStyle}>
        <div style={{ color: '#888', marginBottom: 6 }}>
          Codec fixture <code>SpatialCanvasViewer</code> - local <code>jpeg2k.zarr</code>
        </div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, marginBottom: 8 }}>
          <a href={fixtureUrl} style={{ color: '#8af' }}>
            Store
          </a>
          <a href={manifestUrl} style={{ color: '#8af' }}>
            Manifest
          </a>
          <span style={{ color: '#aaa' }}>
            Coordinate system: <code>{coordinateSystem ?? '-'}</code>
          </span>
          <span style={{ color: '#aaa' }}>
            Layers: <code>{layerOrder.length}</code>
          </span>
        </div>
        {error ? (
          <div style={{ color: '#d99' }}>
            Generate the fixture with <code>pnpm test:fixtures:generate:codecs</code>.
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
  const fixtureUrl = useMemo(() => getLocalJpeg2kCodecFixtureUrl(), []);
  const manifestUrl = useMemo(() => getLocalJpeg2kCodecManifestUrl(), []);

  return (
    <SpatialDataProvider source={fixtureUrl}>
      <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
        <CodecFixtureViewer fixtureUrl={fixtureUrl} manifestUrl={manifestUrl} />
      </div>
    </SpatialDataProvider>
  );
}
