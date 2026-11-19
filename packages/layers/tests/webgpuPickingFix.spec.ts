import { type Device, PresentationContext } from '@luma.gl/core';
import { describe, expect, it } from 'vitest';
import { applyWebGPUPickingFix } from '../src/webgpu/pickingFix';

/** A presentation context without a canvas: a 100×50 drawing buffer at ratio 1. */
function fakeContext(device: Device) {
  const context = Object.create(PresentationContext.prototype);
  context.device = device;
  context.cssToDeviceRatio = () => 1;
  context.getDrawingBufferSize = () => [100, 50];
  return context;
}

// Only `type` is read, plus identity for registration; no default canvas context.
const fakeDevice = (type: string) =>
  ({ type, canvasContext: null, createPresentationContext: () => null }) as unknown as Device;

describe('applyWebGPUPickingFix', () => {
  it('keeps a top-left origin for presentation contexts made before it was applied', () => {
    const device = fakeDevice('webgpu');
    const early = fakeContext(device);
    applyWebGPUPickingFix(device);
    // deck-picker asks for WebGL's bottom-left origin.
    expect(early.cssToDevicePixels([10, 5], true).y).toBe(5);
    expect(fakeContext(device).cssToDevicePixels([10, 5], true).y).toBe(5);
  });

  it('leaves other devices’ contexts as asked', () => {
    const webgl = fakeDevice('webgl');
    applyWebGPUPickingFix(webgl);
    for (const device of [webgl, fakeDevice('webgpu')]) {
      expect(fakeContext(device).cssToDevicePixels([10, 5], true).y).not.toBe(5);
    }
  });
});
