import { type Device, PresentationContext } from '@luma.gl/core';
import { describe, expect, it, vi } from 'vitest';
import { applyWebGPUPresentationAlphaFix } from '../src/webgpu/presentationAlphaFix';

/** A presentation context as luma builds one, without a canvas: only what the fix and
 *  `getCurrentFramebuffer` touch. */
function fakeContext(device: { type: string }) {
  const context = Object.create(PresentationContext.prototype);
  context.device = device;
  context.props = { alphaMode: 'opaque' };
  context._configureDevice = vi.fn(function (this: typeof context) {
    context.configuredWith = this.props.alphaMode;
  });
  context._resizeDrawingBufferIfNeeded = () => {};
  context._getCurrentFramebuffer = () => 'framebuffer';
  return context;
}

// Only `type` is read, plus identity for registration.
const fakeDevice = (type: string) => ({ type }) as unknown as Device;

describe('applyWebGPUPresentationAlphaFix', () => {
  it('makes a WebGPU device’s presentation contexts premultiplied, including ones made before it', () => {
    const device = fakeDevice('webgpu');
    const early = fakeContext(device);
    applyWebGPUPresentationAlphaFix(device);
    const late = fakeContext(device);

    for (const context of [early, late]) {
      expect(context.getCurrentFramebuffer()).toBe('framebuffer');
      context.getCurrentFramebuffer();
      expect(context.configuredWith).toBe('premultiplied');
      expect(context._configureDevice).toHaveBeenCalledTimes(1);
    }
  });

  it('leaves other devices’ contexts alone', () => {
    const webgl = fakeDevice('webgl');
    applyWebGPUPresentationAlphaFix(webgl);
    for (const context of [fakeContext(webgl), fakeContext(fakeDevice('webgpu'))]) {
      context.getCurrentFramebuffer();
      expect(context._configureDevice).not.toHaveBeenCalled();
      expect(context.props.alphaMode).toBe('opaque');
    }
  });
});
