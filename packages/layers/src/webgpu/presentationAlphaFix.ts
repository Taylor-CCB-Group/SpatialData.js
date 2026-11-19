import { type Device, PresentationContext } from '@luma.gl/core';

const fixedDevices = new WeakSet<Device>();
const configured = new WeakSet<PresentationContext>();
let patched = false;

function usePremultipliedAlpha(context: PresentationContext): void {
  if (configured.has(context) || !fixedDevices.has(context.device)) return;
  configured.add(context);
  if (context.props.alphaMode === 'premultiplied') return;
  context.props.alphaMode = 'premultiplied';
  // Protected in luma; it is what applies `alphaMode`, here and on every resize.
  const configure: unknown = Reflect.get(context, '_configureDevice');
  if (typeof configure === 'function') configure.call(context);
}

function patchPresentationContext(): void {
  if (patched) return;
  patched = true;
  const { getCurrentFramebuffer } = PresentationContext.prototype;
  PresentationContext.prototype.getCurrentFramebuffer = function (
    this: PresentationContext,
    options
  ) {
    usePremultipliedAlpha(this);
    return getCurrentFramebuffer.call(this, options);
  };
}

/**
 * Experimental workaround for deck.gl 9.4's multi-canvas mode (`_canvases`) on WebGPU.
 *
 * deck asks for a premultiplied-alpha canvas when it owns one canvas, but creates each
 * `_canvases` presentation context without an `alphaMode`, so luma's default, opaque,
 * applies: wherever a cell is empty or translucent the page behind it is replaced by
 * black. This switches each presentation context on this device to premultiplied
 * before it is first drawn, including those deck created before `onDeviceInitialized`.
 *
 * Call it from Deck's `onDeviceInitialized`. It patches luma's `PresentationContext`
 * once, but acts only for devices passed here; a no-op on WebGL. Harmless once deck
 * passes `alphaMode` itself — remove it then.
 */
export function applyWebGPUPresentationAlphaFix(device: Device): void {
  if (device.type !== 'webgpu') return;
  fixedDevices.add(device);
  patchPresentationContext();
}
