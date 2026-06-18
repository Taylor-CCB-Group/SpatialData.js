import { SpatialDataProvider, useSpatialData } from '@spatialdata/react';
import { useEffect, useMemo, useState } from 'react';
import { type LayerConfig, SpatialCanvas, SpatialCanvasViewer, type ViewState } from '../../src/index';
import { buildHeadlessLayersForCoordinateSystem } from './buildHeadlessLayers';
import {
  getLocalHtj2kEncodeDemoFixtureUrl,
  getLocalHtj2kEncodeDemoManifestUrl,
  getLocalJpeg2kCodecFixtureUrl,
  getLocalJpeg2kCodecManifestUrl,
} from './fixtureUrls';

type CodecFixtureKind = 'jpeg2k' | 'htj2k';

type Htj2kEncodeDemoVariant = {
  label: string;
  suffix: string;
  image_key: string;
  image_path: string;
  lossless: boolean;
  encoded_bytes: number;
  compression_ratio: number | null;
};

type Htj2kEncodeDemoManifest = {
  format: string;
  store: string;
  image: { kind: string; shape: number[]; dtype: string };
  chunks: number[];
  multiscale_levels: number;
  variants: Htj2kEncodeDemoVariant[];
};

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
    storeName: 'htj2k-demo.zarr',
    getFixtureUrl: getLocalHtj2kEncodeDemoFixtureUrl,
    getManifestUrl: getLocalHtj2kEncodeDemoManifestUrl,
  },
};

const panelStyle = {
  flexShrink: 0,
  padding: '10px 12px',
  borderBottom: '1px solid #333',
  background: '#1e1e1e',
  fontSize: 12,
} as const;

const selectStyle = {
  background: '#2a2a2a',
  color: '#eee',
  border: '1px solid #444',
  borderRadius: 4,
  padding: '4px 8px',
} as const;

const viewerShellStyle = {
  flex: 1,
  minHeight: 0,
  position: 'relative' as const,
};

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MiB`;
}

function HeadlessCodecFixtureViewer({
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

function Htj2kEncodeDemoPanel({
  fixtureUrl,
  manifestUrl,
  htj2kDemo,
}: {
  fixtureUrl: string;
  manifestUrl: string;
  htj2kDemo: Htj2kEncodeDemoManifest | null;
}) {
  const imageShape = htj2kDemo?.image.shape;
  const multiscaleLevels = htj2kDemo?.multiscale_levels;

  return (
    <div style={panelStyle}>
      <div style={{ color: '#888', marginBottom: 6 }}>
        HTJ2K encode demo <code>SpatialCanvas</code> - local <code>{htj2kDemo?.store ?? 'htj2k-demo.zarr'}</code>
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, marginBottom: 8 }}>
        <a href={fixtureUrl} style={{ color: '#8af' }}>
          Store
        </a>
        <a href={manifestUrl} style={{ color: '#8af' }}>
          Manifest
        </a>
        {imageShape ? (
          <span style={{ color: '#aaa' }}>
            Image: <code>{imageShape.slice(-2).join('×')}</code>
            {multiscaleLevels != null ? (
              <>
                {' '}
                · <code>{multiscaleLevels}</code> scales
              </>
            ) : null}
          </span>
        ) : null}
        <span style={{ color: '#aaa' }}>
          Images: <code>{htj2kDemo?.variants.length ?? '-'}</code>
        </span>
      </div>
      {htj2kDemo ? (
        <div style={{ color: '#888', marginBottom: 8 }}>
          Toggle <code>mandelbrot_*</code> layers to compare HTJ2K presets (balanced{' '}
          <code>q=0.0002</code>, small <code>q=0.001</code>). Interactive per-<code>q</code>{' '}
          transcoding in the viewer is planned for a later pass.
        </div>
      ) : null}
      {htj2kDemo ? (
        <table style={{ width: '100%', borderCollapse: 'collapse', color: '#ccc' }}>
          <thead>
            <tr style={{ color: '#888', textAlign: 'left' }}>
              <th style={{ padding: '4px 8px 4px 0' }}>Image key</th>
              <th style={{ padding: '4px 8px' }}>Preset</th>
              <th style={{ padding: '4px 8px' }}>Encoded</th>
              <th style={{ padding: '4px 8px' }}>Ratio</th>
            </tr>
          </thead>
          <tbody>
            {htj2kDemo.variants.map((variant) => (
              <tr key={variant.image_key}>
                <td style={{ padding: '4px 8px 4px 0' }}>
                  <code>{variant.image_key}</code>
                </td>
                <td style={{ padding: '4px 8px' }}>{variant.label}</td>
                <td style={{ padding: '4px 8px' }}>{formatBytes(variant.encoded_bytes)}</td>
                <td style={{ padding: '4px 8px' }}>
                  {variant.compression_ratio != null ? `${variant.compression_ratio.toFixed(1)}×` : '-'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
    </div>
  );
}

export default function CodecFixtureDemo() {
  const [fixtureKind, setFixtureKind] = useState<CodecFixtureKind>('jpeg2k');
  const [htj2kDemo, setHtj2kDemo] = useState<Htj2kEncodeDemoManifest | null>(null);
  const [htj2kDemoError, setHtj2kDemoError] = useState<string | null>(null);

  const fixtureConfig = FIXTURE_CONFIG[fixtureKind];

  useEffect(() => {
    if (fixtureKind !== 'htj2k') {
      setHtj2kDemo(null);
      setHtj2kDemoError(null);
      return;
    }
    let cancelled = false;
    const manifestUrl = getLocalHtj2kEncodeDemoManifestUrl();
    fetch(manifestUrl)
      .then(async (response) => {
        if (!response.ok) {
          throw new Error(`${response.status} ${response.statusText}`);
        }
        return (await response.json()) as Htj2kEncodeDemoManifest;
      })
      .then((manifest) => {
        if (cancelled) return;
        setHtj2kDemo(manifest);
        setHtj2kDemoError(null);
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setHtj2kDemo(null);
        setHtj2kDemoError(error instanceof Error ? error.message : String(error));
      });
    return () => {
      cancelled = true;
    };
  }, [fixtureKind]);

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
            style={selectStyle}
          >
            <option value="jpeg2k">JP2K (imagecodecs_jpeg2k)</option>
            <option value="htj2k">HTJ2K encode demo (experimental.openjph_htj2k)</option>
          </select>
        </label>
        {htj2kDemoError ? (
          <div style={{ color: '#d99', marginTop: 8 }}>
            HTJ2K encode-demo manifest unavailable ({htj2kDemoError}). Run{' '}
            <code>pnpm test:fixtures:generate:codecs</code>.
          </div>
        ) : null}
      </div>
      {fixtureKind === 'htj2k' ? (
        <SpatialDataProvider source={fixtureUrl}>
          <Htj2kEncodeDemoPanel fixtureUrl={fixtureUrl} manifestUrl={manifestUrl} htj2kDemo={htj2kDemo} />
          <div style={viewerShellStyle}>
            <SpatialCanvas />
          </div>
        </SpatialDataProvider>
      ) : (
        <SpatialDataProvider source={fixtureUrl}>
          <HeadlessCodecFixtureViewer
            fixtureKind={fixtureKind}
            fixtureUrl={fixtureUrl}
            manifestUrl={manifestUrl}
          />
        </SpatialDataProvider>
      )}
    </div>
  );
}
