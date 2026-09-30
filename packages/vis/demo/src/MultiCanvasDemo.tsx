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
import { LineLayer, PathLayer, ScatterplotLayer } from 'deck.gl';
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

/** What the last hover pick returned, kept to draw it back into the views. */
type Hovered = {
  view: string;
  layerId?: string;
  labelId?: number;
  /** Bounds `[left, bottom, right, top]` of the primitive tile layer that was hit. */
  tileBounds?: number[];
  /** Position of a picked scatter point. */
  pickedPoint?: [number, number];
  /** Where the pointer really is, unprojected by us rather than taken from the pick. */
  pointer?: [number, number];
};

// A stock deck layer alongside ours, so deck's own autoHighlight shows where picks land.
const GRID_POINTS: [number, number][] = Array.from({ length: 256 }, (_, k) => [
  (k % 16) * 32 + 16,
  Math.floor(k / 16) * 32 + 16,
]);

/**
 * The picked tile's extent. `info.sourceLayer` is the TileLayer, not the per-tile
 * sublayer, so this reads the tile deck attaches to the pick instead.
 */
function tileBoundsOf(info: PickingInfo): number[] | undefined {
  const bbox = (info as PickingInfo & { tile?: { bbox?: Record<string, number> } }).tile?.bbox;
  if (!bbox || !('left' in bbox)) return undefined;
  return [bbox.left, bbox.bottom, bbox.right, bbox.top];
}

function tileOutline(bounds: number[]): [number, number][] {
  const [l, b, r, t] = bounds;
  return [
    [l, t],
    [r, t],
    [r, b],
    [l, b],
    [l, t],
  ];
}

function hoverLayers(hovered: Hovered | null): Layer[] {
  if (!hovered) return [];
  const { view } = hovered;
  const layers: Layer[] = [];
  if (hovered.tileBounds) {
    layers.push(
      new PathLayer({
        id: `hover-tile@${view}`,
        data: [tileOutline(hovered.tileBounds)],
        getPath: (d: [number, number][]) => d,
        getColor: [255, 255, 255, 200],
        getWidth: 2,
        widthUnits: 'pixels',
      }) as unknown as Layer
    );
  }
  if (hovered.pointer) {
    // Lines long enough to cross any orthographic view of this data.
    const [x, y] = hovered.pointer;
    const reach = 1e6;
    layers.push(
      new LineLayer({
        id: `hover-crosshair@${view}`,
        data: [
          [
            [x - reach, y],
            [x + reach, y],
          ],
          [
            [x, y - reach],
            [x, y + reach],
          ],
        ],
        getSourcePosition: (d: [number, number][]) => d[0],
        getTargetPosition: (d: [number, number][]) => d[1],
        getColor: [0, 255, 0, 200],
        getWidth: 1,
        widthUnits: 'pixels',
      }) as unknown as Layer
    );
  }
  const markers = hovered.pickedPoint
    ? [{ position: hovered.pickedPoint, color: [255, 60, 60, 255] }]
    : [];
  if (markers.length) {
    layers.push(
      new ScatterplotLayer({
        id: `hover-markers@${view}`,
        data: markers,
        getPosition: (d: (typeof markers)[number]) => d.position,
        getFillColor: (d: (typeof markers)[number]) => d.color as [number, number, number, number],
        getRadius: 4,
        radiusUnits: 'pixels',
      }) as unknown as Layer
    );
  }
  return layers;
}

function buildLayers(sources: Sources, hovered: Hovered | null): Layer[] {
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
  // Same element in both views, so a label picked in either canvas lights up in both.
  const labels = (view: string) =>
    new LabelsLayer({
      id: `labels@${view}`,
      loader: sources.labels,
      channelColors: [[255, 200, 0]],
      channelOpacities: [0.25],
      highlightedLabelId: hovered?.labelId ?? -1,
      highlightColor: [255, 0, 0, 200],
    }) as unknown as Layer;
  return [
    new DeviceAdaptiveImageLayer({ id: 'image-device@left', vivLayer }) as unknown as Layer,
    labels('left'),
    labels('right'),
    new ScatterplotLayer({
      id: 'grid@left',
      data: GRID_POINTS,
      getPosition: (d: [number, number]) => d,
      getRadius: 6,
      radiusUnits: 'common',
      getFillColor: [255, 255, 255, 50],
      pickable: true,
      autoHighlight: true,
      highlightColor: [0, 255, 255, 255],
    }) as unknown as Layer,
    ...hoverLayers(hovered),
  ];
}

function MultiCanvasViewer() {
  const sources = useBlobsSources();
  const [status, setStatus] = useState('Creating WebGPU device…');
  const [hovered, setHovered] = useState<Hovered | null>(null);
  const deckRef = useRef<Deck | null>(null);
  const deviceRef = useRef<Device | null>(null);
  const [device, setDevice] = useState<Device | null>(null);

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
        setDevice(device);
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

  const layers = useMemo(
    () => (sources ? buildLayers(sources, hovered) : null),
    [sources, hovered]
  );

  useEffect(() => {
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
          const viewport = info.viewport;
          if (!viewport || info.x < 0) {
            setHovered(null);
            return;
          }
          const object = info.object as { labelId?: number } | [number, number] | null | undefined;
          const pointer = viewport.unproject([info.x, info.y]) as [number, number];
          // Ignore our own overlay layers; they are not pickable, but be explicit.
          const hit = info.layer && !info.layer.id.startsWith('hover-') ? info.layer : null;
          setHovered({
            view: viewport.id,
            layerId: hit?.id,
            labelId: object && !Array.isArray(object) ? object.labelId : undefined,
            tileBounds: hit ? tileBoundsOf(info) : undefined,
            pickedPoint: Array.isArray(object) ? object : undefined,
            pointer: [pointer[0], pointer[1]],
          });
        },
        onError: (e: Error) => setStatus(`deck error: ${e.message}`),
      });
    }
    deckRef.current.setProps({ layers });
  }, [device, layers]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      <div style={{ padding: '8px 12px', fontSize: 12, borderBottom: '1px solid #333' }}>
        {status} · {sources ? 'data loaded' : 'loading data…'} · hover:{' '}
        {hovered
          ? `${hovered.view} → ${hovered.layerId ?? 'nothing'}${hovered.labelId ? ` label ${hovered.labelId}` : ''}` +
            ` · pointer (${hovered.pointer?.map((v) => v.toFixed(0)).join(', ')})` +
            (hovered.pickedPoint ? ` · picked point (${hovered.pickedPoint.join(', ')})` : '')
          : '—'}
        <div style={{ color: '#888', marginTop: 4 }}>
          green crosshair = pointer · red dot = picked grid point (cyan = deck autoHighlight) ·
          white box = picked tile · red label = picked label (both views)
        </div>
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
