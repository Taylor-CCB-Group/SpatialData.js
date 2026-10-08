import { Deck, OrthographicView } from '@deck.gl/core';
import { webgpuAdapter } from '@luma.gl/webgpu';
import { applyWebGPUViewFix } from '@spatialdata/layers';
import { useEffect, useRef } from 'react';
import {
  VIEWS_CANVAS_SIZE,
  VIEWS_CLEAR_COLOR,
  VIEWS_INSET,
  VIEWS_SAMPLE_POINTS,
  type ViewsSample,
  type ViewsWebGPUState,
} from './viewsWebGPUContract';

/**
 * A WebGPU deck with a full-canvas view and a smaller inset view that clears to an
 * opaque colour, as Viv's OverviewView does. No layers: where the clear lands shows
 * both whether the inset draws at all and whether it is placed upright. `&fix=1`
 * applies `applyWebGPUViewFix` as a consumer would.
 */

const applyFix = new URLSearchParams(window.location.search).get('fix') === '1';

declare global {
  interface Window {
    viewsWebGPU: ViewsWebGPUState;
  }
}

window.viewsWebGPU = { deviceType: null, samples: null, errors: [] };

function readSamples(canvas: HTMLCanvasElement): ViewsWebGPUState['samples'] {
  const readback = document.createElement('canvas');
  readback.width = canvas.width;
  readback.height = canvas.height;
  const context = readback.getContext('2d', { willReadFrequently: true });
  if (!context) return null;
  context.drawImage(canvas, 0, 0);
  const read = (name: ViewsSample) => {
    const [x, y] = VIEWS_SAMPLE_POINTS[name];
    return Array.from(context.getImageData(x, y, 1, 1).data);
  };
  return { inset: read('inset'), mirrored: read('mirrored'), outside: read('outside') };
}

export function ViewsWebGPUConsumer() {
  const container = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!container.current) return;

    const canvas = document.createElement('canvas');
    canvas.style.width = `${VIEWS_CANVAS_SIZE}px`;
    canvas.style.height = `${VIEWS_CANVAS_SIZE}px`;
    container.current.appendChild(canvas);

    const deck = new Deck({
      canvas,
      width: VIEWS_CANVAS_SIZE,
      height: VIEWS_CANVAS_SIZE,
      useDevicePixels: false,
      deviceProps: { type: 'webgpu', adapters: [webgpuAdapter] },
      views: [
        new OrthographicView({ id: 'main' }),
        new OrthographicView({
          id: 'inset',
          ...VIEWS_INSET,
          clear: true,
          clearColor: [...VIEWS_CLEAR_COLOR],
        }),
      ],
      initialViewState: { target: [0, 0, 0], zoom: 0 },
      controller: false,
      layers: [],
      onDeviceInitialized: (device) => {
        if (applyFix) applyWebGPUViewFix(device);
        window.viewsWebGPU.deviceType = device.type;
      },
      onAfterRender: () => {
        window.viewsWebGPU.samples = readSamples(canvas);
      },
      onError: (error) => {
        window.viewsWebGPU.errors.push(error.message);
        console.error(`Views WebGPU deck error: ${error.message}`);
      },
    });

    return () => deck.finalize();
  }, []);

  return <div ref={container} data-testid="views-webgpu" />;
}
