import { Deck, OrthographicView } from '@deck.gl/core';
import { webgpuAdapter } from '@luma.gl/webgpu';
import { LabelsLayer } from '@spatialdata/layers';
import { useEffect, useRef } from 'react';
import { type LabelsPickWebGPUState, WEBGPU_CANVAS_SIZE } from './labelsPickWebGPUContract';

/**
 * Labels picking on a WebGPU deck, where labels are drawn by the WGSL
 * `RasterTileLayer` rather than the GLSL bitmask layer.
 *
 * Picks go through `pickObjectAsync`, as hover does on WebGPU: the synchronous
 * pick reads pixels back and throws there.
 */

const RASTER_SIZE = 64;

/** Label 1 top-left quadrant, label 2 bottom-right, background elsewhere. */
function buildSyntheticLabels(): Uint32Array {
  const data = new Uint32Array(RASTER_SIZE * RASTER_SIZE);
  const half = RASTER_SIZE / 2;
  for (let y = 0; y < RASTER_SIZE; y += 1) {
    for (let x = 0; x < RASTER_SIZE; x += 1) {
      if (x < half && y < half) data[y * RASTER_SIZE + x] = 1;
      else if (x >= half && y >= half) data[y * RASTER_SIZE + x] = 2;
    }
  }
  return data;
}

const syntheticRaster = {
  data: buildSyntheticLabels(),
  width: RASTER_SIZE,
  height: RASTER_SIZE,
};

/** Frames drawn since the loader handed the raster over; `-1` until it has. */
let framesSinceRaster = -1;

const syntheticLoader = {
  getRaster: async () => {
    framesSinceRaster = Math.max(framesSinceRaster, 0);
    return syntheticRaster;
  },
};

declare global {
  interface Window {
    labelsPickWebGPU: LabelsPickWebGPUState;
    /** The label id deck's async pick finds at a canvas pixel, or `null` for none. */
    labelsPickWebGPUAt: ((x: number, y: number) => Promise<number | null>) | null;
  }
}

window.labelsPickWebGPU = { deviceType: null, ready: false, errors: [] };
window.labelsPickWebGPUAt = null;

function buildLayer() {
  return new LabelsLayer({
    id: 'labels:synthetic-webgpu',
    loader: syntheticLoader,
    selections: [{}],
    channelColors: [[255, 255, 255]],
    channelOpacities: [1],
  });
}

export function LabelsPickWebGPUConsumer() {
  const container = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!container.current) return;

    const canvas = document.createElement('canvas');
    canvas.style.width = `${WEBGPU_CANVAS_SIZE}px`;
    canvas.style.height = `${WEBGPU_CANVAS_SIZE}px`;
    container.current.appendChild(canvas);

    const deck = new Deck({
      canvas,
      width: WEBGPU_CANVAS_SIZE,
      height: WEBGPU_CANVAS_SIZE,
      useDevicePixels: false,
      deviceProps: { type: 'webgpu', adapters: [webgpuAdapter] },
      views: new OrthographicView({ id: 'labels' }),
      // zoom 3 scales the 64-unit raster to the full 512px canvas.
      initialViewState: { target: [RASTER_SIZE / 2, RASTER_SIZE / 2, 0], zoom: 3 },
      controller: false,
      layers: [buildLayer()],
      onDeviceInitialized: (device) => {
        window.labelsPickWebGPU.deviceType = device.type;
      },
      onAfterRender: () => {
        // A few frames after the raster arrives, its tile layer has been built and drawn.
        if (framesSinceRaster >= 0) framesSinceRaster += 1;
        window.labelsPickWebGPU.ready = framesSinceRaster >= 3;
      },
      onError: (error) => {
        window.labelsPickWebGPU.errors.push(error.message);
        console.error(`Labels WebGPU deck error: ${error.message}`);
      },
    });

    window.labelsPickWebGPUAt = async (x, y) => {
      const labelId = (await deck.pickObjectAsync({ x, y }))?.object?.labelId;
      return typeof labelId === 'number' ? labelId : null;
    };

    // Deck only draws when it has a reason to; keep frames coming so `ready` is
    // re-evaluated after the raster arrives.
    const interval = window.setInterval(() => deck.setProps({ layers: [buildLayer()] }), 100);

    return () => {
      window.clearInterval(interval);
      window.labelsPickWebGPUAt = null;
      deck.finalize();
    };
  }, []);

  return <div ref={container} data-testid="labels-webgpu-ready" />;
}
