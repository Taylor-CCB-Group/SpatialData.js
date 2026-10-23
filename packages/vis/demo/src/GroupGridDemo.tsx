/**
 * Isolated-group caching in a grid of views (docs/plans/render-stack-hierarchy.md).
 *
 * The shape of MDV's density grid: every cell shows the same shared layers, under one
 * view state, with a different overlay of its own on top. Here the shared layers are an
 * isolated group (circles, plus a Viv image with `?image=1`), and each cell's overlay
 * sits outside it. Layers reach cells the way Viv routes them: `layerFilter` matches
 * the view id carried in the root layer's id, and `@shared` matches every cell.
 *
 * The group should be drawn once per frame for all cells, and not at all when only the
 * overlays change or a cell is added. The counters below show how often it is drawn and
 * why. `?device=webgl` switches backends (default webgpu); `?tileDelay=500` makes the
 * image's tile arrive late, which should cost exactly one `contents` draw.
 */

import { Deck, type Layer, OrthographicView, type OrthographicViewState } from '@deck.gl/core';
import { webgpuAdapter } from '@luma.gl/webgpu';
import {
  applyWebGPUPickingFix,
  applyWebGPUViewFix,
  getIsolatedGroupMember,
  IsolatedGroupLayer,
  type IsolationRenderEvent,
  type IsolationRenderReason,
} from '@spatialdata/layers';
import { useEffect, useRef, useState } from 'react';
import {
  BACKDROP,
  circles,
  GREEN,
  RED,
  type Rgb,
  syntheticImageLoader,
  vivImageLayers,
} from './groupDemoLayers';

const WIDTH = 640;
const HEIGHT = 360;
const params = new URLSearchParams(window.location.search);
const DEVICE: 'webgl' | 'webgpu' = params.get('device') === 'webgl' ? 'webgl' : 'webgpu';
const IMAGE = params.get('image') === '1';

const CELL_W = 200;
const CELL_H = 170;
const GAP = 10;
const COLUMNS = 3;
const MAX_CELLS = 6;
const INITIAL_VIEW_STATE: OrthographicViewState = { target: [160, 0, 0], zoom: -0.5 };

const OVERLAY_PALETTES: Rgb[][] = [
  [
    [250, 200, 40],
    [240, 120, 200],
    [120, 230, 230],
  ],
  [
    [255, 255, 255],
    [30, 30, 30],
    [250, 120, 20],
  ],
];

const imageLoader = IMAGE ? syntheticImageLoader(Number(params.get('tileDelay') ?? 0)) : null;

// The shared members keep stable data and layer identity across updates, as a real
// producer must (see docs/docs/vis/layer-prop-flow.mdx). A fresh data array would make
// deck redraw the member, and so the group, on every update.
const sharedImageLayers = imageLoader ? vivImageLayers(imageLoader, '@shared', CELL_W, CELL_H) : [];
const BACKDROP_DATA = [{ position: [160, 0] as [number, number], radius: 150, color: BACKDROP }];
const RED_DATA = [{ position: [120, 0] as [number, number], radius: 70, color: RED }];
const greenData = new Map<string, { position: [number, number]; radius: number; color: Rgb }[]>();
function sharedGreenData(color: Rgb) {
  const key = color.join();
  let data = greenData.get(key);
  if (!data) {
    data = [{ position: [200, 0], radius: 70, color }];
    greenData.set(key, data);
  }
  return data;
}

function cellRect(index: number) {
  const col = index % COLUMNS;
  const row = Math.floor(index / COLUMNS);
  return { x: col * (CELL_W + GAP), y: row * (CELL_H + GAP), width: CELL_W, height: CELL_H };
}

function cellViews(count: number): OrthographicView[] {
  return Array.from(
    { length: count },
    (_, i) => new OrthographicView({ id: `cell-${i}`, ...cellRect(i), controller: true })
  );
}

interface Scene {
  cells: number;
  overlayPalette: number;
  sharedGreen: Rgb;
}

function buildLayers(scene: Scene, onTargetRender: (event: IsolationRenderEvent) => void): Layer[] {
  const backdrop = circles('backdrop@shared', BACKDROP_DATA, 1);
  const shared = new IsolatedGroupLayer({
    id: 'iso@shared',
    opacity: 0.5,
    onTargetRender,
    layers: [
      ...sharedImageLayers,
      circles('iso-red@shared', RED_DATA, 1),
      circles('iso-green@shared', sharedGreenData(scene.sharedGreen), 1),
    ],
  });
  const palette = OVERLAY_PALETTES[scene.overlayPalette];
  // One per cell, standing in for that cell's density layer.
  const overlays = Array.from({ length: scene.cells }, (_, i) =>
    circles(
      `overlay@cell-${i}`,
      [{ position: [60 + 30 * i, 100], radius: 25, color: palette[i % palette.length] }],
      1
    )
  );
  return [backdrop, shared, ...overlays];
}

/** World point → canvas pixel in a cell. */
function cellPixel(index: number, [x, y]: [number, number], viewState: OrthographicViewState) {
  const rect = cellRect(index);
  const zoom = typeof viewState.zoom === 'number' ? viewState.zoom : 0;
  const scale = 2 ** zoom;
  const [tx, ty] = viewState.target ?? [0, 0, 0];
  return [
    Math.round(rect.x + rect.width / 2 + (x - tx) * scale),
    Math.round(rect.y + rect.height / 2 + (y - ty) * scale),
  ];
}

type Counts = Record<IsolationRenderReason, number>;
const emptyCounts = (): Counts => ({ new: 0, view: 0, contents: 0 });

export default function GroupGridDemo() {
  const container = useRef<HTMLDivElement>(null);
  const deckRef = useRef<Deck | null>(null);
  const sceneRef = useRef<Scene>({ cells: 3, overlayPalette: 0, sharedGreen: GREEN });
  const viewStateRef = useRef<OrthographicViewState>(INITIAL_VIEW_STATE);
  const totals = useRef<Counts>(emptyCounts());
  const frameDraws = useRef<Counts>(emptyCounts());
  const frames = useRef(0);
  const drawLog = useRef<string[]>([]);
  const [log, setLog] = useState('');
  const [hover, setHover] = useState('');
  const [readout, setReadout] = useState('starting');
  const [samples, setSamples] = useState('');

  const applySceneRef = useRef(() => {});

  useEffect(() => {
    if (!container.current) return;
    const applyScene = () => {
      const deck = deckRef.current;
      if (!deck) return;
      const scene = sceneRef.current;
      const views = cellViews(scene.cells);
      deck.setProps({
        views,
        viewState: Object.fromEntries(views.map((view) => [view.id, viewStateRef.current])),
        layers: buildLayers(scene, (event) => {
          drawLog.current.push(
            `frame ${frames.current}: ${event.reason} ${event.width}x${event.height} for ${event.viewportId}`
          );
          totals.current[event.reason] += 1;
          frameDraws.current[event.reason] += 1;
        }),
      });
    };
    applySceneRef.current = applyScene;
    const canvas = document.createElement('canvas');
    canvas.style.width = `${WIDTH}px`;
    canvas.style.height = `${HEIGHT}px`;
    container.current.prepend(canvas);
    const deck = new Deck({
      canvas,
      width: WIDTH,
      height: HEIGHT,
      useDevicePixels: false,
      ...(DEVICE === 'webgpu'
        ? { deviceProps: { type: 'webgpu', adapters: [webgpuAdapter] } }
        : {}),
      onDeviceInitialized: (device) => {
        applyWebGPUViewFix(device);
        applyWebGPUPickingFix(device);
      },
      // Viv's convention: a root layer draws in the view whose id its own id carries.
      layerFilter: ({ layer, viewport }) =>
        layer.id.endsWith('@shared') || layer.id.endsWith(`@${viewport.id}`),
      // One view state for every cell, as in MDV's grid.
      onViewStateChange: ({ viewState }) => {
        viewStateRef.current = viewState;
        applyScene();
        return viewState;
      },
      onHover: (info) => {
        setHover(
          info.picked
            ? `view=${info.viewport?.id} layer=${info.layer?.id} member=${
                getIsolatedGroupMember(info)?.id ?? '-'
              } index=${info.index}`
            : 'none'
        );
      },
      onAfterRender: () => {
        frames.current += 1;
        const last = frameDraws.current;
        const total = totals.current;
        setReadout(
          `frames ${frames.current} · group target draws: total ${
            total.new + total.view + total.contents
          } (new ${total.new}, view ${total.view}, contents ${total.contents}) · this frame ${
            last.new + last.view + last.contents
          }`
        );
        frameDraws.current = emptyCounts();
        setLog(drawLog.current.slice(-6).join('\n'));

        const readback = document.createElement('canvas');
        readback.width = canvas.width;
        readback.height = canvas.height;
        const context = readback.getContext('2d', { willReadFrequently: true });
        if (!context) return;
        context.drawImage(canvas, 0, 0);
        const lines = Array.from({ length: sceneRef.current.cells }, (_, i) => {
          const pick = (point: [number, number]) => {
            const [px, py] = cellPixel(i, point, viewStateRef.current);
            const d = context.getImageData(px, py, 1, 1).data;
            return `(${d[0]}, ${d[1]}, ${d[2]})`;
          };
          return `cell ${i}: shared overlap ${pick([160, 0])}  overlay ${pick([60 + 30 * i, 100])}`;
        });
        setSamples(lines.join('\n'));
      },
    });
    deckRef.current = deck;
    applyScene();
    return () => {
      deck.finalize();
      deckRef.current = null;
      canvas.remove();
    };
  }, []);

  const update = (change: (scene: Scene) => Scene) => () => {
    sceneRef.current = change(sceneRef.current);
    applySceneRef.current();
  };

  const button = (label: string, onClick: () => void) => (
    <button type="button" onClick={onClick} style={{ marginRight: 8 }}>
      {label}
    </button>
  );

  return (
    <div style={{ padding: 16, color: '#ddd', fontFamily: 'monospace', fontSize: 12 }}>
      <div style={{ marginBottom: 8 }}>
        device:{' '}
        <a href={`?device=webgpu${IMAGE ? '&image=1' : ''}`} style={{ color: '#8af' }}>
          webgpu
        </a>{' '}
        <a href={`?device=webgl${IMAGE ? '&image=1' : ''}`} style={{ color: '#8af' }}>
          webgl
        </a>{' '}
        |{' '}
        {button(
          'recolour overlays',
          update((s) => ({ ...s, overlayPalette: 1 - s.overlayPalette }))
        )}
        {button(
          'recolour shared member',
          update((s) => ({ ...s, sharedGreen: s.sharedGreen === GREEN ? [40, 160, 220] : GREEN }))
        )}
        {button(
          'add cell',
          update((s) => ({ ...s, cells: Math.min(MAX_CELLS, s.cells + 1) }))
        )}
        {button(
          'remove cell',
          update((s) => ({ ...s, cells: Math.max(1, s.cells - 1) }))
        )}
      </div>
      <div
        ref={container}
        style={{ position: 'relative', width: WIDTH, height: HEIGHT, background: '#000' }}
      />
      <div id="group-grid-readout">{readout}</div>
      <pre>{samples}</pre>
      <pre id="group-grid-log">{log}</pre>
      <div id="group-grid-hover">hover: {hover}</div>
    </div>
  );
}
