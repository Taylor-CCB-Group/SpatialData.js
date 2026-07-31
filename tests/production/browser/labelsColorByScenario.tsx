import { Deck, OrthographicView } from '@deck.gl/core';
import { type LabelFeatureState, LabelsLayer } from '@spatialdata/layers';
import { useEffect, useRef } from 'react';
import {
  CHANNEL_COLOR,
  LABEL_1_COLOR,
  LABEL_2_COLOR,
  type LabelsColorBySamples,
  type SampledPixel,
} from './labelsColorByContract';

/**
 * Labels feature colouring, read back off the GPU.
 *
 * The raster is synthetic rather than a fixture: what is under test is the path
 * from `featureState` to the colour a fragment ends up with — the LUT build, its
 * texture upload, the props reaching the bitmask sublayer, and the shader's
 * `useFeatureColors` branch. A real store adds loading, tiling and coordinate
 * transforms in front of all of that, none of which can fail in a way this
 * scenario would attribute correctly.
 *
 * Everything is arranged so the expected pixel is EXACTLY the feature colour:
 * full channel opacity, filled, and zero stroke width (which short-circuits the
 * outline mask, whose colour is mixed toward white). A pixel that comes back as
 * the channel colour instead means feature colouring did not reach the shader.
 */

const RASTER_SIZE = 64;
const CANVAS_SIZE = 512;

/** Left half is label 1, right half is label 2; label 0 (background) is never drawn. */
function buildSyntheticLabels(): Uint32Array {
  const data = new Uint32Array(RASTER_SIZE * RASTER_SIZE);
  for (let y = 0; y < RASTER_SIZE; y += 1) {
    for (let x = 0; x < RASTER_SIZE; x += 1) {
      data[y * RASTER_SIZE + x] = x < RASTER_SIZE / 2 ? 1 : 2;
    }
  }
  return data;
}

// Hoisted so their identity is stable across the forced re-renders below: the
// layer memoises its LUT by `featureState` identity, and a fresh object every
// frame would rebuild and re-upload the table instead of exercising the steady
// state this scenario is about.
const syntheticRaster = {
  data: buildSyntheticLabels(),
  width: RASTER_SIZE,
  height: RASTER_SIZE,
};

/** The single-scale labels path asks its loader for exactly this. */
const syntheticLoader = {
  getRaster: async () => syntheticRaster,
};

const featureState: LabelFeatureState = {
  fillColorByFeatureId: {
    '1': [...LABEL_1_COLOR],
    '2': [...LABEL_2_COLOR],
  },
};

/** Band centres, far enough from the label boundary to be unambiguous interior. */
const samplePoints = {
  label1: [CANVAS_SIZE * 0.25, CANVAS_SIZE * 0.5],
  label2: [CANVAS_SIZE * 0.75, CANVAS_SIZE * 0.5],
} as const;

declare global {
  interface Window {
    labelsColorByDeckErrors: string[];
    labelsColorByRenderFrames: number;
    labelsColorBySamples: LabelsColorBySamples | null;
  }
}

window.labelsColorByDeckErrors = [];
window.labelsColorByRenderFrames = 0;
window.labelsColorBySamples = null;

/**
 * Sample the drawing buffer.
 *
 * Called from `onAfterRender`, which is the only point at which this is possible
 * without `preserveDrawingBuffer`: the WebGL back buffer is still readable inside
 * the frame that drew it, and is discarded once control returns to the browser.
 */
function sampleCanvas(canvas: HTMLCanvasElement): LabelsColorBySamples | null {
  const readback = document.createElement('canvas');
  readback.width = canvas.width;
  readback.height = canvas.height;
  const context = readback.getContext('2d', { willReadFrequently: true });
  if (!context) return null;
  context.drawImage(canvas, 0, 0);
  const at = ([x, y]: readonly [number, number]): SampledPixel => {
    const { data } = context.getImageData(Math.round(x), Math.round(y), 1, 1);
    return [data[0], data[1], data[2], data[3]];
  };
  return { label1: at(samplePoints.label1), label2: at(samplePoints.label2) };
}

function buildLayer() {
  return new LabelsLayer({
    id: 'labels:synthetic',
    loader: syntheticLoader,
    selections: [{}],
    visible: true,
    opacity: 1,
    channelColors: [[...CHANNEL_COLOR] as [number, number, number]],
    channelsVisible: [true],
    // Full fill opacity and no outline: the sampled pixel is then the feature
    // colour itself rather than something blended with the channel colour.
    channelOpacities: [1],
    channelOutlineOpacities: [1],
    channelsFilled: [true],
    channelStrokeWidths: [0],
    featureState,
  });
}

export function LabelsColorByConsumer() {
  const container = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!container.current) return;

    const canvas = document.createElement('canvas');
    canvas.width = CANVAS_SIZE;
    canvas.height = CANVAS_SIZE;
    canvas.style.width = `${CANVAS_SIZE}px`;
    canvas.style.height = `${CANVAS_SIZE}px`;
    container.current.appendChild(canvas);

    const deck = new Deck({
      canvas,
      width: CANVAS_SIZE,
      height: CANVAS_SIZE,
      // Keep drawing-buffer pixels and CSS pixels one to one, so the sample
      // coordinates above are the ones actually read.
      useDevicePixels: false,
      views: new OrthographicView({ id: 'labels' }),
      // zoom 3 scales the 64-unit raster to the full 512px canvas.
      initialViewState: { target: [RASTER_SIZE / 2, RASTER_SIZE / 2, 0], zoom: 3 },
      controller: false,
      layers: [buildLayer()],
      onAfterRender: () => {
        window.labelsColorByRenderFrames += 1;
        window.labelsColorBySamples = sampleCanvas(canvas);
      },
      onError: (error) => {
        window.labelsColorByDeckErrors.push(error.message);
        console.error(`Labels colour-by deck error: ${error.message}`);
      },
    });

    // The raster arrives asynchronously and deck only draws when it has a reason
    // to. Nudging it keeps frames coming after the load settles, so the sample
    // above is taken from a steady frame rather than whichever one happened last.
    const interval = window.setInterval(() => deck.setProps({ layers: [buildLayer()] }), 100);

    return () => {
      window.clearInterval(interval);
      deck.finalize();
    };
  }, []);

  return <div ref={container} data-testid="labels-ready" />;
}
