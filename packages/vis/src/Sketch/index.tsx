import { SpatialDataProvider, useSpatialData } from '@spatialdata/react';
import type { DeckGLProps } from 'deck.gl';
import { type CSSProperties, useEffect, useState } from 'react';
import SpatialCanvas from '../SpatialCanvas';
import Transforms from '../Transforms';
import SpatialDataTree from '../Tree';
import {
  buildDemoPageHref,
  DEFAULT_DEMO_SPATIALDATA_URL,
  getSpatialDataUrlFromSearchParams,
  isAntialiasDisabled,
  isWebGPURequested,
} from './demoUrl';

const dataSourceBarStyle: CSSProperties = {
  flexShrink: 0,
  padding: '8px 12px',
  borderBottom: '1px solid #333',
  background: '#1e1e1e',
};

function getInitialDemoUrl(): string {
  if (typeof window === 'undefined') {
    return DEFAULT_DEMO_SPATIALDATA_URL;
  }
  return getSpatialDataUrlFromSearchParams(new URLSearchParams(window.location.search));
}

function DataSource({ children }: React.PropsWithChildren) {
  const [url, setUrl] = useState(getInitialDemoUrl);

  useEffect(() => {
    const nextHref = buildDemoPageHref(url);
    if (window.location.href !== nextHref) {
      window.history.replaceState(null, '', nextHref);
    }
  }, [url]);

  const shareHref =
    typeof window !== 'undefined'
      ? buildDemoPageHref(url, `${window.location.origin}${window.location.pathname}`)
      : '';

  const source = url.trim() || DEFAULT_DEMO_SPATIALDATA_URL;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      <div style={dataSourceBarStyle}>
        <div style={{ fontSize: 12, color: '#888', marginBottom: 4 }}>
          SpatialData URL <span style={{ color: '#666' }}>(or open with ?url=…)</span>
        </div>
        <input
          type="text"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          style={{ width: '100%', boxSizing: 'border-box', padding: '6px 8px' }}
        />
        {shareHref ? (
          <a
            href={shareHref}
            style={{ display: 'inline-block', marginTop: 6, fontSize: 11, color: '#8af' }}
          >
            Link to this dataset
          </a>
        ) : null}
      </div>
      <div style={{ flex: 1, minHeight: 0, overflow: 'auto' }}>
        <SpatialDataProvider source={source}>{children}</SpatialDataProvider>
      </div>
    </div>
  );
}

type DemoDevice =
  | { kind: 'webgl'; deckProps?: Partial<DeckGLProps> }
  | { kind: 'loading' }
  | { kind: 'webgpu'; deckProps: Partial<DeckGLProps> }
  | { kind: 'unavailable'; reason: string };

const NO_MSAA_DECK_PROPS: Partial<DeckGLProps> = {
  deviceProps: { webgl: { antialias: false } },
};

function getDemoSearchParams(): URLSearchParams {
  return new URLSearchParams(typeof window === 'undefined' ? '' : window.location.search);
}

/**
 * `?webgpu` opts the demo into deck's WebGPU device. The adapter is imported only
 * then, and the canvas waits for it: deck picks its device once, at creation.
 * `?antialias=0` drops WebGL's MSAA (WebGPU has none to drop).
 */
function useDemoDevice(): DemoDevice {
  const [requested] = useState(() => isWebGPURequested(getDemoSearchParams()));
  const [device, setDevice] = useState<DemoDevice>(() =>
    !requested
      ? isAntialiasDisabled(getDemoSearchParams())
        ? { kind: 'webgl', deckProps: NO_MSAA_DECK_PROPS }
        : { kind: 'webgl' }
      : 'gpu' in navigator
        ? { kind: 'loading' }
        : { kind: 'unavailable', reason: 'WebGPU was requested but this browser has none.' }
  );
  useEffect(() => {
    if (device.kind !== 'loading') return;
    let cancelled = false;
    import('@luma.gl/webgpu')
      .then(({ webgpuAdapter }) => {
        if (cancelled) return;
        setDevice({
          kind: 'webgpu',
          deckProps: { deviceProps: { type: 'webgpu', adapters: [webgpuAdapter] } },
        });
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setDevice({ kind: 'unavailable', reason: `Could not load WebGPU support: ${error}` });
      });
    return () => {
      cancelled = true;
    };
  }, [device.kind]);
  return device;
}

// biome-ignore lint/correctness/noUnusedVariables: dev-only debug view, toggled via the commented <Repr /> usage below.
function Repr() {
  const { spatialData } = useSpatialData();
  return <pre style={{ maxWidth: '90vw' }}>{spatialData?.toString()}</pre>;
}

export default function Sketch() {
  const device = useDemoDevice();
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
        {/* <Repr /> */}

        <section style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 360 }}>
          <h3 style={{ margin: '0 0 8px', fontSize: 14 }}>
            SpatialCanvas
            {device.kind === 'webgpu' ? ' (WebGPU, experimental)' : ''}
            {device.kind === 'webgl' && device.deckProps ? ' (WebGL, MSAA off)' : ''}
          </h3>
          <div style={{ flex: 1, minHeight: 0 }}>
            {device.kind === 'webgl' ? <SpatialCanvas deckProps={device.deckProps} /> : null}
            {device.kind === 'webgpu' ? <SpatialCanvas deckProps={device.deckProps} /> : null}
            {device.kind === 'loading' ? 'Loading WebGPU…' : null}
            {device.kind === 'unavailable' ? device.reason : null}
          </div>
        </section>

        <SpatialDataTree />
        {/* <Table /> */}
        <Transforms />
        {/* <ImageView /> */}
      </div>
    </DataSource>
  );
}
