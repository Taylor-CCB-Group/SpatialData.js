/**
 * Render-to-target spike for isolated groups (docs/plans/render-stack-hierarchy.md).
 *
 * Left: two circles at 50% opacity each, no group — the red shows through the green
 * where they overlap. Right: the same circles at full opacity inside an
 * `IsolatedGroupLayer` at 50% — the overlap shows green only. Both sit over an opaque
 * blue backdrop. Pixel samples are read back after each frame.
 *
 * `?device=webgl` switches backends (default webgpu); `?blend=multiply` etc. sets the
 * group's blend mode; `?nested=1` wraps the group in a second, pass-through-looking
 * isolated group, which should not change the picture.
 *
 * `?views=2` adds a picture-in-picture inset showing the group at half scale. Layers
 * reach views the way Viv routes them: each view gets its own copy of the scene, with
 * the view id in every layer id, and deck's `layerFilter` matches on it. So each view
 * has its own group instance, and with it its own offscreen target. `?group=0` draws
 * the right-hand circles ungrouped, as a control.
 */

import { Deck, Layer, OrthographicView } from '@deck.gl/core';
import { ScatterplotLayer } from '@deck.gl/layers';
import { webgpuAdapter } from '@luma.gl/webgpu';
import { type GroupBlendMode, IsolatedGroupLayer } from '@spatialdata/layers';
import { useEffect, useRef, useState } from 'react';

const WIDTH = 640;
const HEIGHT = 360;
const params = new URLSearchParams(window.location.search);
const DEVICE: 'webgl' | 'webgpu' = params.get('device') === 'webgl' ? 'webgl' : 'webgpu';
const BLEND_MODES: GroupBlendMode[] = ['normal', 'additive', 'multiply', 'screen', 'max', 'min'];
const BLEND = (BLEND_MODES.find((mode) => mode === params.get('blend')) ??
  'normal') satisfies GroupBlendMode;
const NESTED = params.get('nested') === '1';
const VIEWS = params.get('views') === '2';
/**
 * `?clear=0` leaves the inset uncleared. deck 9.4 breaks a `clear: true` view on
 * WebGPU: it begins the clear pass while the main pass is still open, and the view
 * never draws. Viv's OverviewView sets `clear: true`, so it hits this too.
 */
const CLEAR_INSET = params.get('clear') !== '0';
const GROUPED = params.get('group') !== '0';

type ViewId = 'main' | 'inset';
const INSET = { x: 400, y: 200, width: 220, height: 140 };
const VIEW_STATES = {
  main: { target: [0, 0, 0] as [number, number, number], zoom: 0 },
  inset: { target: [160, 0, 0] as [number, number, number], zoom: -1 },
};

type Circle = { position: [number, number]; radius: number; color: [number, number, number] };

function circles(id: string, data: Circle[], opacity: number): ScatterplotLayer<Circle> {
  return new ScatterplotLayer<Circle>({
    id,
    data,
    getPosition: (d) => d.position,
    getRadius: (d) => d.radius,
    getFillColor: (d) => d.color,
    opacity,
    pickable: true,
  });
}

const RED: [number, number, number] = [230, 40, 40];
const GREEN: [number, number, number] = [40, 200, 60];

function flatChildren(group: IsolatedGroupLayer): Layer[] {
  return group.props.layers.filter((layer): layer is Layer => layer instanceof Layer);
}

function buildLayers(view: ViewId): Layer[] {
  const tag = (id: string) => `${id}@${view}`;
  const backdrop = circles(
    tag('backdrop'),
    [
      { position: [-160, 0], radius: 150, color: [60, 120, 200] },
      { position: [160, 0], radius: 150, color: [60, 120, 200] },
    ],
    1
  );
  const loose = [
    circles(tag('loose-red'), [{ position: [-200, 0], radius: 70, color: RED }], 0.5),
    circles(tag('loose-green'), [{ position: [-120, 0], radius: 70, color: GREEN }], 0.5),
  ];
  const isolated = new IsolatedGroupLayer({
    id: tag('iso'),
    opacity: 0.5,
    blendMode: BLEND,
    layers: [
      circles(tag('iso-red'), [{ position: [120, 0], radius: 70, color: RED }], 1),
      circles(tag('iso-green'), [{ position: [200, 0], radius: 70, color: GREEN }], 1),
    ],
  });
  const group = NESTED
    ? new IsolatedGroupLayer({ id: tag('outer'), layers: [isolated] })
    : isolated;
  if (!GROUPED) return [backdrop, ...loose, ...flatChildren(isolated)];
  return [backdrop, ...loose, group];
}

/** World point → canvas pixel in a view (orthographic, y down). */
function toPixel(view: ViewId, [x, y]: [number, number]): [number, number] {
  const frame = view === 'main' ? { x: 0, y: 0, width: WIDTH, height: HEIGHT } : INSET;
  const { target, zoom } = VIEW_STATES[view];
  const scale = 2 ** zoom;
  return [
    Math.round(frame.x + frame.width / 2 + (x - target[0]) * scale),
    Math.round(frame.y + frame.height / 2 + (y - target[1]) * scale),
  ];
}

function insideInset([px, py]: [number, number]): boolean {
  return (
    px >= INSET.x && px < INSET.x + INSET.width && py >= INSET.y && py < INSET.y + INSET.height
  );
}

const WORLD_SAMPLES: Array<[string, ViewId, [number, number]]> = [
  ['loose overlap', 'main', [-160, 0]],
  ['loose red only', 'main', [-235, 0]],
  ['iso overlap', 'main', [160, 0]],
  ['iso red only', 'main', [85, 0]],
  ['iso backdrop only (empty group)', 'main', [160, 110]],
  ['outside everything', 'main', [0, 170]],
  ['inset iso overlap', 'inset', [160, 0]],
  ['inset iso red only', 'inset', [85, 0]],
  ['inset iso backdrop only', 'inset', [160, 110]],
];

/**
 * deck 9.4 places a non-full-canvas view upside down on WebGPU (its viewport y is
 * computed for WebGL's bottom-left origin). These samples read the inset where WebGPU
 * actually draws it, to check the group composites correctly inside that view.
 */
function mirroredInsetSamples(): Array<[string, [number, number]]> {
  if (!(VIEWS && DEVICE === 'webgpu')) return [];
  const flip = HEIGHT - 2 * INSET.y - INSET.height;
  return WORLD_SAMPLES.filter(([, view]) => view === 'inset').map(([name, view, world]) => {
    const [x, y] = toPixel(view, world);
    return [`${name} (mirrored)`, [x, y + flip]];
  });
}

/** Main-view samples the inset covers are dropped; inset samples need the inset. */
const SAMPLES: Array<[string, [number, number]]> = WORLD_SAMPLES.flatMap(
  ([name, view, world]): Array<[string, [number, number]]> => {
    const pixel = toPixel(view, world);
    if (view === 'inset' ? !VIEWS : VIEWS && insideInset(pixel)) return [];
    return [[name, pixel]];
  }
).concat(mirroredInsetSamples());

export default function GroupBlendDemo() {
  const container = useRef<HTMLDivElement>(null);
  const [samples, setSamples] = useState('');
  const [hover, setHover] = useState('');
  const [status, setStatus] = useState('starting');

  useEffect(() => {
    if (!container.current) return;
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
      views: [
        new OrthographicView({ id: 'main', controller: true }),
        ...(VIEWS ? [new OrthographicView({ id: 'inset', ...INSET, clear: CLEAR_INSET })] : []),
      ],
      initialViewState: VIEW_STATES,
      layers: [...buildLayers('main'), ...(VIEWS ? buildLayers('inset') : [])],
      // Viv's convention: a layer draws in the view whose id its own id carries.
      layerFilter: ({ layer, viewport }) => layer.id.endsWith(`@${viewport.id}`),
      onAfterRender: () => {
        const readback = document.createElement('canvas');
        readback.width = canvas.width;
        readback.height = canvas.height;
        const context = readback.getContext('2d', { willReadFrequently: true });
        if (!context) return;
        context.drawImage(canvas, 0, 0);
        const lines = SAMPLES.map(([name, [x, y]]) => {
          const px = context.getImageData(x, y, 1, 1).data;
          return `${name.padEnd(34)} rgba(${px[0]}, ${px[1]}, ${px[2]}, ${px[3]})`;
        });
        setSamples(lines.join('\n'));
        setStatus(`rendered on ${deck.device?.type ?? '?'}`);
      },
      onHover: (info) => {
        setHover(
          info.layer ? `layer=${info.layer.id} sourceLayer=${info.sourceLayer?.id}` : 'none'
        );
      },
      onError: (error) => setStatus(`deck error: ${error.message}`),
    });
    return () => {
      deck.finalize();
      canvas.remove();
    };
  }, []);

  const link = (label: string, query: Record<string, string>) => {
    const next = new URLSearchParams({
      device: DEVICE,
      blend: BLEND,
      ...(NESTED ? { nested: '1' } : {}),
      ...(VIEWS ? { views: '2' } : {}),
      ...query,
    });
    return (
      <a key={label} href={`?${next}`} style={{ color: '#8af', marginRight: 10 }}>
        {label}
      </a>
    );
  };

  return (
    <div style={{ padding: 16, color: '#ddd', fontFamily: 'monospace', fontSize: 12 }}>
      <div style={{ marginBottom: 8 }}>
        device: {link('webgpu', { device: 'webgpu' })}
        {link('webgl', { device: 'webgl' })} | blend:{' '}
        {BLEND_MODES.map((mode) => link(mode, { blend: mode }))} |{' '}
        {link(NESTED ? 'unnest' : 'nest', { nested: NESTED ? '0' : '1' })}{' '}
        {link(VIEWS ? 'one view' : 'inset view', { views: VIEWS ? '1' : '2' })}
      </div>
      <div
        ref={container}
        style={{ position: 'relative', width: WIDTH, height: HEIGHT, background: '#000' }}
      />
      <div>
        {status} · device={DEVICE} blend={BLEND} nested={String(NESTED)} views=
        {VIEWS ? 2 : 1}
      </div>
      <pre>{samples}</pre>
      <div>hover: {hover}</div>
    </div>
  );
}
