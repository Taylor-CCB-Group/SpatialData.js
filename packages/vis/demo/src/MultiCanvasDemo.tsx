/**
 * Experiment: one imperative Deck on an app-owned WebGPU device, presenting into two
 * canvases through deck 9.4's experimental `_canvases` mode.
 *
 * `<DeckGL>` can't be used here: it always passes its own `canvas`, which multi-canvas
 * mode rejects. Layers from both panels live in one layer list; `layerFilter` routes
 * them to their view, and each view is bound to a canvas by `canvasId`.
 */
import { Deck, type Layer, OrthographicView, type PickingInfo } from '@deck.gl/core';
import { MultiscaleImageLayer } from '@hms-dbmi/viv';
import type { Device } from '@luma.gl/core';
import { luma } from '@luma.gl/core';
import { webgpuAdapter } from '@luma.gl/webgpu';
import { loadOmeZarrMultiscalesData } from '@spatialdata/avivatorish';
import { DeviceAdaptiveImageLayer, LabelsLayer } from '@spatialdata/layers';
import { SpatialDataProvider, useSpatialData } from '@spatialdata/react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { getLocalBlobsFixtureUrl } from './fixtureUrls';

type PixelSource = {
  shape: number[];
  labels: string[];
  getRaster: (o: { selection: Record<string, number> }) => Promise<{ data: ArrayLike<number> }>;
};

const PANELS = [
  { view: 'left', canvas: 'mc-canvas-left', title: 'image + labels' },
  { view: 'right', canvas: 'mc-canvas-right', title: 'labels only' },
] as const;

async function channelRange(level: PixelSource, c: number): Promise<[number, number]> {
  const { data } = await level.getRaster({ selection: { c } });
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (let i = 0; i < data.length; i++) {
    const v = data[i];
    if (v < min) min = v;
    if (v > max) max = v;
  }
  return [min, max > min ? max : min + 1];
}

type Sources = {
  image: PixelSource[];
  labels: PixelSource[];
  contrastLimits: [number, number][];
};

function useBlobsSources(): Sources | null {
  const { spatialData } = useSpatialData();
  const [sources, setSources] = useState<Sources | null>(null);
  useEffect(() => {
    const image = spatialData?.images?.blobs_multiscale_image;
    const labels = spatialData?.labels?.blobs_multiscale_labels;
    if (!image || !labels) return;
    let cancelled = false;
    (async () => {
      const load = (el: typeof image | typeof labels) =>
        loadOmeZarrMultiscalesData({ store: el.getStore(), url: el.url }) as Promise<PixelSource[]>;
      const [imageLoader, labelsLoader] = await Promise.all([load(image), load(labels)]);
      const coarsest = imageLoader[imageLoader.length - 1];
      const channels = coarsest.shape[coarsest.labels.indexOf('c')] ?? 1;
      const contrastLimits = await Promise.all(
        Array.from({ length: channels }, (_, c) => channelRange(coarsest, c))
      );
      if (!cancelled) setSources({ image: imageLoader, labels: labelsLoader, contrastLimits });
    })();
    return () => {
      cancelled = true;
    };
  }, [spatialData]);
  return sources;
}

function buildLayers(sources: Sources): Layer[] {
  const channels = sources.contrastLimits.length;
  const vivLayer = new MultiscaleImageLayer({
    id: 'image@left',
    loader: sources.image,
    selections: Array.from({ length: channels }, (_, c) => ({ c })),
    contrastLimits: sources.contrastLimits,
    colors: [
      [255, 0, 255],
      [0, 255, 0],
      [0, 128, 255],
    ].slice(0, channels),
    channelsVisible: Array.from({ length: channels }, () => true),
  }) as unknown as Layer;
  const labels = (view: string) =>
    new LabelsLayer({
      id: `labels@${view}`,
      loader: sources.labels,
      channelColors: [[255, 200, 0]],
      channelOpacities: [0.25],
    }) as unknown as Layer;
  return [
    new DeviceAdaptiveImageLayer({ id: 'image-device@left', vivLayer }) as unknown as Layer,
    labels('left'),
    labels('right'),
  ];
}

function MultiCanvasViewer() {
  const sources = useBlobsSources();
  const [status, setStatus] = useState('Creating WebGPU device…');
  const [hover, setHover] = useState<string>('');
  const deckRef = useRef<Deck | null>(null);
  const deviceRef = useRef<Device | null>(null);

  // App-owned device. Multi-canvas mode needs its default context to be offscreen.
  useEffect(() => {
    let cancelled = false;
    luma
      .createDevice({
        type: 'webgpu',
        adapters: [webgpuAdapter],
        createCanvasContext: { canvas: new OffscreenCanvas(1, 1) },
      })
      .then((device) => {
        if (cancelled) {
          device.destroy();
          return;
        }
        deviceRef.current = device;
        setStatus(`device: ${device.type} (${device.info.gpu ?? 'unknown gpu'})`);
      })
      .catch((e: unknown) => setStatus(`device creation failed: ${String(e)}`));
    return () => {
      cancelled = true;
      deckRef.current?.finalize();
      deckRef.current = null;
      deviceRef.current?.destroy();
      deviceRef.current = null;
    };
  }, []);

  const layers = useMemo(() => (sources ? buildLayers(sources) : null), [sources]);

  useEffect(() => {
    const device = deviceRef.current;
    if (!device || !layers) return;
    if (!deckRef.current) {
      deckRef.current = new Deck({
        device,
        _canvases: PANELS.map((p) => p.canvas),
        views: PANELS.map(
          (p) => new OrthographicView({ id: p.view, canvasId: p.canvas, controller: true })
        ),
        initialViewState: Object.fromEntries(
          PANELS.map((p) => [p.view, { target: [256, 256, 0], zoom: -0.3 }])
        ),
        layerFilter: ({ layer, viewport }) => layer.id.endsWith(`@${viewport.id}`),
        onHover: (info: PickingInfo) => {
          const object = info.object as { labelId?: number } | null | undefined;
          setHover(
            info.layer
              ? `${info.viewport?.id}: ${info.layer.id}${object?.labelId ? ` label ${object.labelId}` : ''}`
              : ''
          );
        },
        onError: (e: Error) => setStatus(`deck error: ${e.message}`),
      });
    }
    deckRef.current.setProps({ layers });
  }, [layers, status]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      <div style={{ padding: '8px 12px', fontSize: 12, borderBottom: '1px solid #333' }}>
        {status} · {sources ? 'data loaded' : 'loading data…'} · hover: {hover || '—'}
      </div>
      <div style={{ display: 'flex', flex: 1, minHeight: 0, gap: 8, padding: 8 }}>
        {PANELS.map((p) => (
          <div key={p.canvas} style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
            <div style={{ fontSize: 12, color: '#aaa', marginBottom: 4 }}>{p.title}</div>
            <div style={{ position: 'relative', flex: 1, minHeight: 200, background: '#111' }}>
              <canvas
                id={p.canvas}
                style={{ position: 'absolute', inset: 0, width: '100%', height: '100%' }}
              />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

export default function MultiCanvasDemo() {
  const fixtureUrl = useMemo(() => getLocalBlobsFixtureUrl(), []);
  return (
    <SpatialDataProvider source={fixtureUrl}>
      <MultiCanvasViewer />
    </SpatialDataProvider>
  );
}
