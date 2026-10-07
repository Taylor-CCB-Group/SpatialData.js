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
 */

import { Deck, type Layer, OrthographicView } from '@deck.gl/core';
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

function buildLayers(): Layer[] {
  const backdrop = circles(
    'backdrop',
    [
      { position: [-160, 0], radius: 150, color: [60, 120, 200] },
      { position: [160, 0], radius: 150, color: [60, 120, 200] },
    ],
    1
  );
  const loose = [
    circles('loose-red', [{ position: [-200, 0], radius: 70, color: RED }], 0.5),
    circles('loose-green', [{ position: [-120, 0], radius: 70, color: GREEN }], 0.5),
  ];
  const isolated = new IsolatedGroupLayer({
    id: 'iso',
    opacity: 0.5,
    blendMode: BLEND,
    layers: [
      circles('iso-red', [{ position: [120, 0], radius: 70, color: RED }], 1),
      circles('iso-green', [{ position: [200, 0], radius: 70, color: GREEN }], 1),
    ],
  });
  const group = NESTED ? new IsolatedGroupLayer({ id: 'outer', layers: [isolated] }) : isolated;
  return [backdrop, ...loose, group];
}

/** World point → canvas pixel for the view below (target 0,0, zoom 0, y down). */
const SAMPLES: Record<string, [number, number]> = {
  'loose overlap': [-160, 0],
  'loose red only': [-235, 0],
  'iso overlap': [160, 0],
  'iso red only': [85, 0],
  'iso backdrop only (empty group)': [160, 110],
  'outside everything': [0, 170],
};

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
      views: new OrthographicView({ id: 'groups', controller: true }),
      initialViewState: { target: [0, 0, 0], zoom: 0 },
      layers: buildLayers(),
      onAfterRender: () => {
        const readback = document.createElement('canvas');
        readback.width = canvas.width;
        readback.height = canvas.height;
        const context = readback.getContext('2d', { willReadFrequently: true });
        if (!context) return;
        context.drawImage(canvas, 0, 0);
        const lines = Object.entries(SAMPLES).map(([name, [x, y]]) => {
          const px = context.getImageData(
            Math.round(x + WIDTH / 2),
            Math.round(y + HEIGHT / 2),
            1,
            1
          ).data;
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
        {link(NESTED ? 'unnest' : 'nest', { nested: NESTED ? '0' : '1' })}
      </div>
      <div
        ref={container}
        style={{ position: 'relative', width: WIDTH, height: HEIGHT, background: '#000' }}
      />
      <div>
        {status} · device={DEVICE} blend={BLEND} nested={String(NESTED)}
      </div>
      <pre>{samples}</pre>
      <div>hover: {hover}</div>
    </div>
  );
}
