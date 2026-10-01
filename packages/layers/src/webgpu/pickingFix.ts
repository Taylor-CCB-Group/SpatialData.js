import type { CanvasContext, Device, PresentationContext } from '@luma.gl/core';

type PixelConverter = Pick<CanvasContext | PresentationContext, 'cssToDevicePixels'>;

const fixedContexts = new WeakSet<PixelConverter>();
const fixedDevices = new WeakSet<Device>();

/** Keep a context's CSS→device pixel conversion in WebGPU's top-left origin. */
function useTopLeftOrigin(context: PixelConverter): void {
  if (fixedContexts.has(context)) return;
  const original = context.cssToDevicePixels.bind(context);
  context.cssToDevicePixels = (cssPixel, _yInvert) => original(cssPixel, false);
  fixedContexts.add(context);
}

/**
 * Experimental workaround for deck.gl 9.4 picking on WebGPU.
 *
 * deck-picker converts every pick point with `cssToDevicePixels(…, true)`, WebGL's
 * bottom-left origin, on WebGPU too, so each pick reads the vertically mirrored
 * pixel. luma's own picker passes `device.type !== 'webgpu'`; this makes the
 * device's canvas contexts answer as if deck did the same. Call it from Deck's
 * `onDeviceInitialized`. A no-op on WebGL, and harmless once deck is fixed (deck
 * will then pass `false` itself) — remove it then.
 */
export function applyWebGPUPickingFix(device: Device): void {
  if (device.type !== 'webgpu' || fixedDevices.has(device)) return;
  fixedDevices.add(device);
  if (device.canvasContext) {
    useTopLeftOrigin(device.getDefaultCanvasContext());
  }
  // Multi-canvas mode picks through per-canvas presentation contexts made later.
  const createPresentationContext = device.createPresentationContext.bind(device);
  device.createPresentationContext = (props) => {
    const context = createPresentationContext(props);
    useTopLeftOrigin(context);
    return context;
  };
}
